// web.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { getClientById } from "./services/db.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";

const router = express.Router();

// 🗄 MongoDB setup for conversation memory
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
    const { message: userMessage, clientId, userId } = req.body;

    if (!userMessage || !clientId || !userId) {
        return res.status(400).json({ reply: "⚠️ Missing message, client ID, or user ID." });
    }

    try {
        // 1️⃣ Get system prompt
        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });

        // 2️⃣ Load existing conversation
        let convo = await getConversation(clientId, userId);
        let history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

        // 3️⃣ Append new user message
        history.push({ role: "user", content: userMessage });

        // 4️⃣ Send to OpenAI with full history
        const reply = await getChatCompletion(history);

        // 5️⃣ Append assistant reply to history
        history.push({ role: "assistant", content: reply });

        // 6️⃣ Save updated conversation
        await saveConversation(clientId, userId, history);

        // 7️⃣ Handle tour booking request
        if (reply.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(reply);
            await sendTourEmail(data);
        }

        res.json({ reply });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
