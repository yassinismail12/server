// web.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { getClientById } from "./services/db.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";
import crypto from "crypto";

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
    let { message: userMessage, clientId, userId } = req.body;

    // ✅ Auto-generate userId if missing
    if (!userId) {
        userId = crypto.randomUUID();
    }
    console.log("Incoming chat request:", { clientId, userId, userMessage });


    if (!userMessage || !clientId) {
        return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
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

        // Ensure reply is a string
        const assistantMessage = typeof reply === "string" ? reply : "";

        // 5️⃣ Append assistant reply to history
        history.push({ role: "assistant", content: assistantMessage });

        // 6️⃣ Save updated conversation
        await saveConversation(clientId, userId, history);

        // 7️⃣ Handle tour booking request
        if (assistantMessage && assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            await sendTourEmail(data);
        }


        // ✅ Return reply + userId so frontend can store it
        res.json({ reply, userId });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
