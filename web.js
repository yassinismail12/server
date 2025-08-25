// web.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
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
        { clientId, userId },
        { $set: { history, updatedAt: new Date() } },
        { upsert: true }
    );
}

// ===== Clients (Message Count & Limit) =====
async function incrementMessageCount(clientId) {
    const db = await connectDB();
    const clients = db.collection("Clients");

    // Make sure the client doc exists and has defaults
    let client = await clients.findOne({ clientId });
    if (!client) {
        client = { clientId, messageCount: 0, messageLimit: 1000 }; // default 100
        await clients.insertOne(client);
    }

    // If over limit → return false
    if (client.messageCount >= client.messageLimit) {
        return { allowed: false, messageCount: client.messageCount, messageLimit: client.messageLimit };
    }

    // Otherwise increment and return updated values
    const updated = await clients.findOneAndUpdate(
        { clientId },
        { $inc: { messageCount: 1 } },
        { returnDocument: "after" }
    );

    return { allowed: true, messageCount: updated.messageCount, messageLimit: updated.messageLimit };
}

// ===== Route =====
router.post("/", async (req, res) => {
    let { message: userMessage, clientId, userId, isFirstMessage } = req.body;

    // Auto-generate userId if missing
    if (!userId) {
        userId = crypto.randomUUID();
    }

    console.log("Incoming chat request:", { clientId, userId, userMessage, isFirstMessage });

    if (!userMessage || !clientId) {
        return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
    }

    try {
        // ✅ Check client’s message limit
        const usage = await incrementMessageCount(clientId);
        if (!usage.allowed) {
            return res.json({
                reply: ``
            });
        }

        // Ensure customer exists
        await findOrCreateCustomer(userId, clientId);

        // Detect if user provided their name
        let nameMatch = null;
        const lowerMsg = userMessage.toLowerCase();

        if (lowerMsg.includes("my name is ")) {
            nameMatch = userMessage.split(/my name is/i)[1]?.trim();
        } else if (userMessage.includes("[Name]")) {
            nameMatch = userMessage.replace("[Name]", "").trim();
        }

        if (nameMatch) {
            await updateCustomerName(userId, clientId, nameMatch);
            console.log(`📝 Name detected and saved: ${nameMatch}`);
        }

        // Get system prompt
        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });
        // ===== Load client files =====
        const db = await connectDB();
        const clientsCollection = db.collection("Clients");
        const clientDoc = await clientsCollection.findOne({ clientId });

        let filesContent = "";
        if (clientDoc?.files?.length) {
            filesContent = clientDoc.files.map(f => `File: ${f.name}\nContent:\n${f.content}`).join("\n\n");
        }


        // Load conversation
        let convo = await getConversation(clientId, userId);

        // Greeting if first message
        let greeting = "";
        if (isFirstMessage) {
            const db = await connectDB();
            const customers = db.collection("Customers");
            const customer = await customers.findOne({ customerId: userId, clientId });

            if (customer?.name) {
                greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
            }
        }

        // Build conversation history
        let history = convo?.history || [
            {
                role: "system",
                content: `${finalSystemPrompt}\n\nUse the following client files to answer questions:\n${filesContent}`
            }
        ];

        history.push({ role: "user", content: userMessage });

        // Call OpenAI
        const assistantMessage = await getChatCompletion(history);

        // Append assistant reply
        history.push({ role: "assistant", content: assistantMessage });

        // Save conversation
        await saveConversation(clientId, userId, history);

        // Handle tour booking
        if (assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            console.log("Sending tour email with data:", data);
            await sendTourEmail(data);
        }

        // Return reply
        res.json({
            reply: greeting + assistantMessage,
            userId,
            usage: { count: usage.messageCount, limit: usage.messageLimit }
        });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
