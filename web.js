import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";

const router = express.Router();

router.post("/", async (req, res) => {
    const userMessage = req.body.message;

    try {
        const reply = await getChatCompletion(SYSTEM_PROMPT, userMessage);
        res.json({ reply });
    } catch (error) {
        console.error("OpenAI Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
