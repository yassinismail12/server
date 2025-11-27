// web.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";
import crypto from "crypto";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== DB Connection =====
async function connectDB() {
    if (!mongoClient.topology?.isConnected()) {
        await mongoClient.connect();
    }
    return mongoClient.db(dbName);
}

// ===== Customers =====
async function findOrCreateCustomer(customerId, clientId) {
    const db = await connectDB();
    const customers = db.collection("Customers");

    let customer = await customers.findOne({ customerId, clientId });
    if (!customer) {
        await customers.insertOne({
            customerId,
            clientId,
            name: null,
            lastInteraction: new Date()
        });
        return null;
    } else {
        await customers.updateOne(
            { customerId, clientId },
            { $set: { lastInteraction: new Date() } }
        );
        return customer.name;
    }
}

async function updateCustomerName(customerId, clientId, name) {
    const db = await connectDB();
    const customers = db.collection("Customers");

    await customers.updateOne(
        { customerId, clientId },
        { $set: { name, lastInteraction: new Date() } }
    );
}

// ===== Conversations =====
async function getConversation(clientId, userId) {
    const db = await connectDB();
    const conversations = db.collection("Conversations");
    return await conversations.findOne({ clientId, userId });
}

async function saveConversation(clientId, userId, history) {
    const db = await connectDB();
    const conversations = db.collection("Conversations");
    await conversations.updateOne(
        { clientId, userId, source: "web" },
        { $set: { history, updatedAt: new Date() } },
        { upsert: true }
    );
}

// ===== Clients (Message Count & Limit) =====
async function incrementMessageCount(clientId) {
  const db = await connectDB();
  const clients = db.collection("Clients");

  const updated = await clients.findOneAndUpdate(
    { clientId },
    {
      $inc: { messageCount: 1 },
      $setOnInsert: { messageLimit: 1000, active: true, quotaWarningSent: false }
    },
    {
      returnDocument: "after",
      upsert: true
    }
  );

  let client = updated.value;

  if (!client) {
    client = await clients.findOne({ clientId });
  }

  if (!client) {
    throw new Error(`Failed to create/find client ${clientId}`);
  }

  if (client.messageCount > client.messageLimit) {
    return {
      allowed: false,
      messageCount: client.messageCount,
      messageLimit: client.messageLimit
    };
  }

  const remaining = client.messageLimit - client.messageCount;
  if (remaining === 100 && !client.quotaWarningSent) {
    await sendQuotaWarning(clientId);
    await clients.updateOne(
      { clientId },
      { $set: { quotaWarningSent: true } }
    );
  }

  return {
    allowed: true,
    messageCount: client.messageCount,
    messageLimit: client.messageLimit
  };
}

// ===== Route =====
router.post("/", async (req, res) => {
    let { message: userMessage, clientId, userId, isFirstMessage } = req.body;

    if (!userId) {
        userId = crypto.randomUUID();
    }

    console.log("Incoming chat request:", { clientId, userId, userMessage, isFirstMessage });

    if (!userMessage || !clientId) {
        return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
    }

    try {
        const db = await connectDB();
        const clientsCollection = db.collection("Clients");
        const clientDoc = await clientsCollection.findOne({ clientId });

        if (!clientDoc) {
            console.log(`❌ Unknown clientId: ${clientId}`);
            return res.status(204).end();
        }

        if (clientDoc.active === false) {
            console.log(`🚫 Inactive client: ${clientId}`);
            return res.status(204).end();
        }

        const usage = await incrementMessageCount(clientId);
        if (!usage.allowed) {
            return res.json({
                reply: ""
            });
        }

        await findOrCreateCustomer(userId, clientId);

        let nameMatch = null;

        const myNameMatch = userMessage.match(/my name is\s+(.+)/i);
        if (myNameMatch) {
            nameMatch = myNameMatch[1].trim();
        }

        const bracketNameMatch = userMessage.match(/\[name\]\s*:\s*(.+)/i);
        if (bracketNameMatch) {
            nameMatch = bracketNameMatch[1].trim();
        }

        if (nameMatch) {
            await updateCustomerName(userId, clientId, nameMatch);
            console.log(`📝 Name detected and saved: ${nameMatch}`);
        }

        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });

        let filesContent = "";
        if (clientDoc?.files?.length) {
            filesContent = clientDoc.files.map(f => `File: ${f.name}\nContent:\n${f.content}`).join("\n\n");
        }

        let convo = await getConversation(clientId, userId);

        let greeting = "";
        if (isFirstMessage) {
            const customer = await db.collection("Customers").findOne({ customerId: userId, clientId });
            if (customer?.name) {
                greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
            }
        }

        let history = convo?.history || [
            {
                role: "system",
                content: `${finalSystemPrompt}\n\nUse the following client files to answer questions:\n${filesContent}`
            }
        ];

        if (req.body.image) {
            history.push({
                role: "user",
                content: [
                    { type: "text", text: userMessage || "Analyze this image" },
                    { type: "image_url", image_url: req.body.image }
                ],
                createdAt: new Date()
            });
        } else {
            history.push({
                role: "user",
                content: userMessage,
                createdAt: new Date()
            });
        }

        let assistantMessage;
        let imageOutputs = [];

        try {
            if (process.env.TEST_MODE === "true") {
                const delay = Math.floor(Math.random() * 300) + 100;
                await new Promise((r) => setTimeout(r, delay));

                assistantMessage = `🧪 Mock reply for ${clientId} — message: "${userMessage.slice(0, 20)}..."`;
                console.log("✅ Test mode active — skipping OpenAI call");
            } else {

                // 🧠 REAL OPENAI CALL
                const aiResponse = await getChatCompletion(history);

                // Extract text + images
                let textOutput = "";
// Responses API returns output array
if (aiResponse.output && Array.isArray(aiResponse.output)) {
    for (const part of aiResponse.output) {
        if (part.type === "output_text" && part.text) {
            textOutput += part.text;
        }
        if (part.type === "output_image" && part.image_url) {
            imageOutputs.push(part.image_url);
        }
    
                    }
                }

                assistantMessage = textOutput;
            }
        } catch (err) {
            console.error("❌ OpenAI error:", err.message);

            await db.collection("Logs").insertOne({
                clientId,
                userId,
                level: "error",
                source: "openai",
                message: err.message,
                timestamp: new Date(),
            });

            assistantMessage = "⚠️ I'm having trouble right now. Please try again later.";
        }

        history.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });

        await saveConversation(clientId, userId, history);

        if (assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            data.clientId = clientId;

            console.log("Sending tour email with data:", data);
            try {
                await sendTourEmail(data);
            } catch (err) {
                console.error("❌ Failed to send tour email:", err.message);
                await db.collection("Logs").insertOne({
                    clientId,
                    userId,
                    level: "error",
                    source: "email",
                    message: err.message,
                    timestamp: new Date(),
                });
            }
        }

        res.json({
            reply: greeting + assistantMessage,
            images: imageOutputs,
            userId,
            usage: { count: usage.messageCount, limit: usage.messageLimit }
        });

   } catch (error) {
        console.error("❌ Error:", error.message);

        try {
            const db = await connectDB();
            await db.collection("Logs").insertOne({
                clientId,
                userId,
                level: "error",
                source: "web",
                message: error.message,
                timestamp: new Date(),
            });
        } catch (dbErr) {
            console.error("❌ Failed to log error in DB:", dbErr.message);
        }

        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
