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

// ===== Customer DB functions =====
async function connectDB() {
    if (!mongoClient.topology?.isConnected()) {
        await mongoClient.connect();
    }
    return mongoClient.db(dbName);
}

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

// ===== Conversation functions =====
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

// ===== Route =====
router.post("/", async (req, res) => {
    let { message: userMessage, clientId, userId } = req.body;

    // Auto-generate userId if missing
    if (!userId) {
        userId = crypto.randomUUID();
    }

    console.log("Incoming chat request:", { clientId, userId, userMessage });

    if (!userMessage || !clientId) {
        return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
    }

    try {
        // Ensure customer exists in DB
        await findOrCreateCustomer(userId, clientId);

        // Detect if user provided their name
        let nameMatch = null;
        const lowerMsg = userMessage.toLowerCase();
        if (lowerMsg.startsWith("my name is ")) {
            nameMatch = userMessage.substring(11).trim();
        } else if (userMessage.includes("[Name]")) {
            nameMatch = userMessage.replace("[Name]", "").trim();
        }

        if (nameMatch) {
            await updateCustomerName(userId, clientId, nameMatch);
            console.log(`📝 Name detected and saved: ${nameMatch}`);
        }

        // Get system prompt
        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });

        // Load existing conversation history
        let convo = await getConversation(clientId, userId);

        // If first message of session and name is known → greet before continuing
        let greeting = "";
        if (!convo) {
            const db = await connectDB();
            const customers = db.collection("Customers");
            const customer = await customers.findOne({ customerId: userId, clientId });

            if (customer?.name) {
                greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
            }
        }

        // Build conversation history
        let history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

        // Append new user message
        history.push({ role: "user", content: userMessage });

        // Call OpenAI
        const assistantMessage = await getChatCompletion(history);

        // Append assistant reply
        history.push({ role: "assistant", content: assistantMessage });

        // Save updated conversation
        await saveConversation(clientId, userId, history);

        // Handle tour booking requests
        if (assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            console.log("Sending tour email with data:", data);
            await sendTourEmail(data);
        }

        // Return reply with greeting if applicable
        res.json({ reply: greeting + assistantMessage, userId });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
