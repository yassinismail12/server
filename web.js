import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { getClientById } from "./services/db.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";

const router = express.Router();

router.post("/", async (req, res) => {
    const { message: userMessage, clientId } = req.body;

    if (!userMessage || !clientId) {
        return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
    }

    try {
        // ⬇️ Get final system prompt with data injected
        const finalSystemPrompt = await SYSTEM_PROMPT(clientId);

        // ✅ Confirm what's being sent (optional)
        console.log("📄 Final System Prompt:\n", finalSystemPrompt);
        console.log("🗣️ User Message:\n", userMessage);

        // ⬇️ Send to OpenAI
        const reply = await getChatCompletion(finalSystemPrompt, userMessage);

        res.json({ reply });
    } catch (error) {
        console.error("❌ OpenAI or DB Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
