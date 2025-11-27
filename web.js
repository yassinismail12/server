import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";
import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== Cloudinary Configuration =====
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
    { returnDocument: "after", upsert: true }
  );

  let client = updated.value;
  if (!client) client = await clients.findOne({ clientId });
  if (!client) throw new Error(`Failed to create/find client ${clientId}`);

  if (client.messageCount > client.messageLimit) {
    return { allowed: false, messageCount: client.messageCount, messageLimit: client.messageLimit };
  }

  const remaining = client.messageLimit - client.messageCount;
  if (remaining === 100 && !client.quotaWarningSent) {
    await sendQuotaWarning(clientId);
    await clients.updateOne({ clientId }, { $set: { quotaWarningSent: true } });
  }

  return { allowed: true, messageCount: client.messageCount, messageLimit: client.messageLimit };
}

// ===== Image helper with Cloudinary =====
async function formatMessageForGPT(userMessage, image) {
    const contentPayload = [];

    // Add text message if provided
    if (userMessage && typeof userMessage === "string" && userMessage.trim()) {
        contentPayload.push({ type: "text", text: userMessage });
    }

    // Handle image: upload to Cloudinary and send URL to OpenAI
    if (image && typeof image === "string" && image.trim()) {
        try {
            let uploadedUrl = image;

            // If image is base64, upload to Cloudinary
            if (image.startsWith("data:image/")) {
                const uploadResponse = await cloudinary.uploader.upload(image, {
                    folder: "user_uploads",
                });
                uploadedUrl = uploadResponse.secure_url;
            }

            // Add uploaded image URL to content for OpenAI
            contentPayload.push({
                type: "image_url",
                image_url: {
                    url: uploadedUrl,
                    detail: "auto"
                }
            });
        } catch (err) {
            console.error("❌ Error uploading image to Cloudinary:", err.message);
        }
    }

    if (contentPayload.length === 0) {
        contentPayload.push({ type: "text", text: "" });
    }

    return contentPayload;
}

// ===== Route =====
router.post("/", async (req, res) => {
    let { message: userMessage, clientId, userId, isFirstMessage, image } = req.body;
    if (!userId) userId = crypto.randomUUID();

    console.log("Incoming chat request:", { 
        clientId, 
        userId, 
        userMessage: userMessage ? `${userMessage.substring(0, 50)}...` : null, 
        isFirstMessage, 
        hasImage: !!image,
        imageLength: image ? image.length : 0
    });

    if ((!userMessage || !userMessage.trim()) && (!image || !image.trim())) {
        return res.status(400).json({ reply: "⚠️ Please provide a message or image." });
    }
    if (!clientId) return res.status(400).json({ reply: "⚠️ Missing client ID." });

    try {
        const db = await connectDB();
        const clientsCollection = db.collection("Clients");
        const clientDoc = await clientsCollection.findOne({ clientId });
        if (!clientDoc || clientDoc.active === false) return res.status(204).end();

        const usage = await incrementMessageCount(clientId);
        if (!usage.allowed) return res.json({ reply: "" });

        await findOrCreateCustomer(userId, clientId);

        // Detect user name
        let nameMatch = null;
        const myNameMatch = userMessage?.match(/my name is\s+(.+)/i);
        const bracketNameMatch = userMessage?.match(/\[name\]\s*:\s*(.+)/i);
        if (myNameMatch) nameMatch = myNameMatch[1].trim();
        if (bracketNameMatch) nameMatch = bracketNameMatch[1].trim();
        if (nameMatch) await updateCustomerName(userId, clientId, nameMatch);

        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });
        let filesContent = "";
        if (clientDoc?.files?.length) {
            filesContent = clientDoc.files.map(f => `File: ${f.name}\nContent:\n${f.content}`).join("\n\n");
        }

        let convo = await getConversation(clientId, userId);
        let greeting = "";
        if (isFirstMessage) {
            const customer = await db.collection("Customers").findOne({ customerId: userId, clientId });
            if (customer?.name) greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
        }

        let history = convo?.history || [
            {
                role: "system",
                content: [{ type: "text", text: `${finalSystemPrompt}\n\nUse the following client files:\n${filesContent}` }]
            }
        ];

        // Format user message and image (Cloudinary integration)
        const userContent = await formatMessageForGPT(userMessage, image);
        history.push({ role: "user", content: userContent, createdAt: new Date() });

        let assistantResponse;
        try {
            if (process.env.TEST_MODE === "true") {
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 300) + 100));
                assistantResponse = { text: "🧪 Mock reply (image supported)", imageUrls: [] };
            } else {
                assistantResponse = await getChatCompletion(history);
            }
        } catch (err) {
            console.error("❌ OpenAI error:", err.message);
            await db.collection("Logs").insertOne({
                clientId, userId, level: "error", source: "openai", message: err.message, timestamp: new Date(),
            });
            assistantResponse = { text: "⚠️ I'm having trouble right now.", imageUrls: [] };
        }

        let assistantMessage = "";
        let imageUrls = [];
        if (typeof assistantResponse === "string") {
            assistantMessage = assistantResponse;
        } else if (assistantResponse && typeof assistantResponse === "object") {
            assistantMessage = assistantResponse.text || "";
            imageUrls = assistantResponse.imageUrls || [];
        }

        const assistantContent = [{ type: "text", text: assistantMessage }];
        if (imageUrls.length > 0) {
            assistantContent.push({ type: "text", text: `\n[Images: ${imageUrls.join(", ")}]` });
        }
        history.push({ role: "assistant", content: assistantContent, createdAt: new Date() });
        await saveConversation(clientId, userId, history);

        res.json({ 
            reply: greeting + assistantMessage, 
            imageUrls: imageUrls,
            userId, 
            usage: { count: usage.messageCount, limit: usage.messageLimit } 
        });

    } catch (error) {
        console.error("❌ Error:", error.message);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
