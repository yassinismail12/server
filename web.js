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

async function getConversation(clientId, userId) {
    await mongoClient.connect();
    const db = mongoClient.db(dbName);
    const conversations = db.collection("Conversations");
    return await conversations.findOne({ clientId, userId });
}

async function saveConversation(clientId, userId, history) {
    const db = mongoClient.db(dbName);
    const conversations = db.collection("Conversations");
    await conversations.updateOne(
        { clientId, userId },
        { $set: { history, updatedAt: new Date() } },
        { upsert: true }
    );
}

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
        // Get system prompt (string)
        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });

        // Load existing conversation history from DB
        let convo = await getConversation(clientId, userId);
        let history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

        console.log("Loaded conversation history:", history);

        // Append new user message to history
        history.push({ role: "user", content: userMessage });

        // Call OpenAI with full history to get assistant reply
        const assistantMessage = await getChatCompletion(history);

        // Append assistant reply to history
        history.push({ role: "assistant", content: assistantMessage });
        console.log("History after user message added:", history);
        // Save updated conversation history
        await saveConversation(clientId, userId, history);

        // Handle tour booking requests
        if (assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            await sendTourEmail(data);
        }

        // Return reply and userId so frontend can keep track
        res.json({ reply: assistantMessage, userId });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
