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
    if (!mongoClient.topology?.isConnected?.()) {
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
    return db.collection("Conversations").findOne({ clientId, userId });
}

async function saveConversation(clientId, userId, history) {
    const db = await connectDB();
    await db.collection("Conversations").updateOne(
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
            $setOnInsert: {
                messageLimit: 1000,
                active: true,
                quotaWarningSent: false
            }
        },
        { returnOriginal: false, upsert: true }  // FIX HERE
    );

    const client = updated.value || updated;  // Fallback for some drivers

    if (!client || client.messageCount === undefined) {
        throw new Error("Client document missing after update");
    }

    if (client.messageCount > client.messageLimit) {
        return { allowed: false };
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


// =======================
//   MAIN CHAT ROUTE
// =======================
// ===== Route =====
router.post("/", async (req, res) => {
    let { message: userMessage, clientId, userId, isFirstMessage, image } = req.body;

    // Auto-generate userId if missing
    if (!userId) {
        userId = crypto.randomUUID();
    }

    console.log("Incoming chat request:", { clientId, userId, userMessage, isFirstMessage });

    if (!userMessage && !image) {
        return res.status(400).json({ reply: "⚠️ Missing message or image." });
    }

    if (!clientId) {
        return res.status(400).json({ reply: "⚠️ Missing client ID." });
    }

    try {
        // =============== CLIENT LOOKUP ===============
        const db = await connectDB();
        const clientsCollection = db.collection("Clients");
        const clientDoc = await clientsCollection.findOne({ clientId });

     if (!clientDoc) {
    console.log(`❌ Unknown clientId: ${clientId}`);
    return res.status(403).json({ error: "Invalid clientId" });
}

if (clientDoc.active === false) {
    console.log(`🚫 Inactive client: ${clientId}`);
    return res.status(403).json({ error: "Client is inactive" });
}

        // =============== LIMIT CHECK ===============
        const usage = await incrementMessageCount(clientId);
        if (!usage.allowed) {
            return res.json({ reply: "" });
        }

        // Ensure customer exists
        await findOrCreateCustomer(userId, clientId);


        // =============== NAME DETECTION ===============
        let nameMatch = null;
        const myNameMatch = userMessage?.match(/my name is\s+(.+)/i);
        if (myNameMatch) nameMatch = myNameMatch[1].trim();

        const bracketNameMatch = userMessage?.match(/\[name\]\s*:\s*(.+)/i);
        if (bracketNameMatch) nameMatch = bracketNameMatch[1].trim();

        if (nameMatch) {
            await updateCustomerName(userId, clientId, nameMatch);
            console.log(`📝 Name detected and saved: ${nameMatch}`);
        }

        // Load client files
        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });

        let filesContent = "";
        if (clientDoc?.files?.length) {
            filesContent = clientDoc.files
                .map(f => `File: ${f.name}\nContent:\n${f.content}`)
                .join("\n\n");
        }

        // Load conversation
        let convo = await getConversation(clientId, userId);

        let greeting = "";
        if (isFirstMessage) {
            const customers = db.collection("Customers");
            const customer = await customers.findOne({ customerId: userId, clientId });

            if (customer?.name) {
                greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
            }
        }

        // =============== HISTORY SETUP ===============
       let history = convo?.history || [
    {
        role: "system",
        content: [
            { type: "text", text: `${finalSystemPrompt}\n\nUse the following client files:\n${filesContent}` }
        ]
    }
];



        // 🖼️ ===================== IMAGE HANDLING =====================
        let contentPayload = [];

        // Always include user's text message (if any)
        if (userMessage) {
            contentPayload.push({ type: "text", text: userMessage });
        }

        // CASE 1: base64 image passed in req.body.image
        if (image && typeof image === "string" && image.startsWith("data:image")) {
            contentPayload.push({
                type: "input_image",
                image_url: image
            });
        }

        // CASE 2: multipart file upload (mobile apps/WebView)
        if (req.files?.length) {
            for (let file of req.files) {
                const base64 = file.buffer.toString("base64");
                contentPayload.push({
                    type: "input_image",
                    image_url: `data:${file.mimetype};base64,${base64}`
                });
            }
        }
        // ===================== END IMAGE HANDLING =====================

        history.push({
            role: "user",
            content: contentPayload,
            createdAt: new Date()
        });

        // =============== OPENAI CALL ===============
        let assistantMessage;

        try {
            if (process.env.TEST_MODE === "true") {
                const delay = Math.floor(Math.random() * 300) + 100;
                await new Promise(r => setTimeout(r, delay));

                assistantMessage = `🧪 Mock reply (image supported)`;
                console.log("Test mode active");
            } else {
                assistantMessage = await getChatCompletion(history);
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

            assistantMessage = "⚠️ I'm having trouble right now.";
        }

        // Save assistant reply
       history.push({
  role: "assistant",
  content: [{ type: "text", text: assistantMessage }],
  createdAt: new Date()
});


        await saveConversation(clientId, userId, history);

        // Handle tour booking
        if (assistantMessage?.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            data.clientId = clientId;

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

        return res.json({
            reply: greeting + assistantMessage,
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
            console.error("❌ DB log failed:", dbErr.message);
        }

        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
