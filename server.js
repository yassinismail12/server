import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import fetch from "node-fetch";
import { OpenAI } from "openai";

// Load environment variables
dotenv.config();

// Setup Express
const app = express();
app.use(cors());
app.use(express.json());

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Load data files
const listingsData = fs.readFileSync("./full_real_estate_data.txt", "utf8");
const paymentPlans = fs.readFileSync("./payment-plans.txt", "utf8");
const faqs = fs.readFileSync("./faqs.txt", "utf8");

// System prompt
const SYSTEM_PROMPT = `
You are a helpful real estate assistant. Answer using only the uploaded files: listings, payment plans, and FAQs.

---

### What You Do:
- Help users find properties that match their preferences (type, location, budget, bedrooms).
- Show property details only if found in the file.
- Ask clarifying questions if needed.
- If no match is found, offer to connect with a human agent.
- If the user wants to book a visit, refer to the booking section from the data.

🟡 Language:
- Reply in the same language as the user: English, Arabic, or Egyptian dialect (عامية).

---

### Answer Format:
Each listing must follow this format exactly, line by line. Use blank lines between listings. Don’t guess or add fake data.

Unit Type: Apartment  
Project: Palm Hills Katameya  
Location: New Cairo  
Bedrooms: 3  
Size: 180 m²  
Price: $135,000  
Features: Balcony, Parking

---
### Example

**Q:** عندك شقة غرفتين في التجمع الخامس بميزانية حوالي 150 ألف؟  
**A:**  
نوع الوحدة: شقة  
المشروع: Palm Hills Katameya  
المكان: التجمع الخامس، القاهرة الجديدة  
عدد الغرف: 2  
المساحة: 170 متر  
السعر: 125,000 دولار  
المميزات: بلكونة، جراج

تحب أظبطلك معاد معاينة أو تبعتلي رقمك للتواصل؟


### Listings  
${listingsData}

---

### Payment Plans  
${paymentPlans}

---

### FAQs  
${faqs}
`;

// Local chatbot (frontend widget)
app.post("/api/chat", async (req, res) => {
    const userMessage = req.body.message;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage }
            ]
        });

        const reply = completion.choices[0].message.content;
        res.json({ reply });
    } catch (error) {
        console.error("OpenAI API Error:", error);
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

// Facebook Messenger verification
app.get("/webhook", (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("✅ Messenger Webhook Verified");
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Facebook Messenger webhook handler
app.post("/webhook", async (req, res) => {
    const body = req.body;

    if (body.object === "page") {
        for (const entry of body.entry) {
            const webhook_event = entry.messaging[0];
            const sender_psid = webhook_event.sender.id;

            if (webhook_event.message && webhook_event.message.text) {
                const userMessage = webhook_event.message.text;

                try {
                    const completion = await openai.chat.completions.create({
                        model: "gpt-4o",
                        messages: [
                            { role: "system", content: SYSTEM_PROMPT },
                            { role: "user", content: userMessage }
                        ]
                    });

                    const reply = completion.choices[0].message.content;

                    await sendMessengerReply(sender_psid, reply);
                } catch (error) {
                    console.error("Messenger AI Error:", error);
                    await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.");
                }
            }
        }

        res.status(200).send("EVENT_RECEIVED");
    } else {
        res.sendStatus(404);
    }
});

// Messenger reply helper
async function sendMessengerReply(sender_psid, response) {
    const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

    await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            recipient: { id: sender_psid },
            message: { text: response }
        })
    });
}

// Test route
app.get("/", (req, res) => {
    res.send("✅ Real Estate Chatbot Backend is running");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
