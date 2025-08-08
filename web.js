// web.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { getClientById } from "./services/db.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";

const router = express.Router();

router.post("/", async (req, res) => {
    const { message: userMessage, clientId } = req.body;

    if (!userMessage || !clientId) {
        return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
    }

    try {
        // ⬇️ Get final system prompt with data injected
        const finalSystemPrompt = await SYSTEM_PROMPT(clientId);

        // ⬇️ Send to OpenAI
        const reply = await getChatCompletion(finalSystemPrompt, userMessage);

        // 📨 Check if AI output contains a tour booking request
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
