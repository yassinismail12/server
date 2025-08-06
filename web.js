import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { getClientByWidgetId } from "./services/db.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";

const router = express.Router();

router.post("/", async (req, res) => {
    const { message: userMessage, clientId } = req.body;

    if (!userMessage || !clientId) {
        return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
    }

    try {
        // ⬇️ Find client by widget ID (which is now called clientId)
        const client = await getClientByWidgetId(clientId);

        if (!client || !client.systemPrompt) {
            return res.status(404).json({ reply: "⚠️ Client not found or missing system prompt." });
        }

        // ⬇️ Use the system prompt from MongoDB
        const reply = await getChatCompletion(client.systemPrompt, userMessage);

        res.json({ reply });
    } catch (error) {
        console.error("❌ OpenAI or DB Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
