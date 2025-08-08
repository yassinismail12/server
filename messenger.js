// messenger.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendMessengerReply } from "./services/messenger.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";

const router = express.Router();

// ✅ Webhook verification (Facebook requirement)
router.get("/", (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// ✅ Messenger message/postback handler
router.post("/", async (req, res) => {
    const body = req.body;

    if (body.object === "page") {
        for (const entry of body.entry) {
            const pageId = entry.id;
            const webhook_event = entry.messaging[0];
            const sender_psid = webhook_event.sender.id;

            // 📩 Handle text message
            if (webhook_event.message?.text) {
                const userMessage = webhook_event.message.text;

                try {
                    const prompt = await SYSTEM_PROMPT({ pageId });
                    const reply = await getChatCompletion(prompt, userMessage);

                    // 📨 If AI says it's a tour booking request, send email
                    if (reply.includes("[TOUR_REQUEST]")) {
                        const data = extractTourData(reply);
                        await sendTourEmail(data);
                    }

                    // Send reply back to Messenger user
                    await sendMessengerReply(sender_psid, reply);

                } catch (error) {
                    console.error("❌ Error handling message:", error);
                    await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.");
                }
            }

            // 📌 Handle Ice Breaker postbacks
            if (webhook_event.postback?.payload) {
                const payload = webhook_event.postback.payload;

                const responses = {
                    ICE_BREAKER_PROPERTIES: "Sure! What type of property are you looking for and in which area?",
                    ICE_BREAKER_BOOK: "You can book a visit by telling me the property you're interested in.",
                    ICE_BREAKER_PAYMENT: "Yes! We offer several payment plans. What’s your budget or preferred duration?",
                };

                if (responses[payload]) {
                    await sendMessengerReply(sender_psid, responses[payload]);
                }
            }
        }

        res.status(200).send("EVENT_RECEIVED");
    } else {
        res.sendStatus(404);
    }
});

export default router;
