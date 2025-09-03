// messenger.js
import express from "express";
import fetch from "node-fetch";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendMessengerReply } from "./services/messenger.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";

const router = express.Router();
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== DB Connection =====
async function connectDB() {
    if (!mongoClient.topology?.isConnected()) {
        await mongoClient.connect();
    }
    return mongoClient.db(dbName);
}

// ===== Clients =====
async function getClientDoc(pageId) {
    const db = await connectDB();
    const clients = db.collection("Clients");
    let client = await clients.findOne({ clientId: pageId });

    if (!client) {
        client = {
            clientId: pageId,
            messageCount: 0,
            messageLimit: 1000,
            active: true,
            VERIFY_TOKEN: null,
            PAGE_ACCESS_TOKEN: null,
        };
        await clients.insertOne(client);
    }

    return client;
}

async function incrementMessageCount(clientId) {
    const db = await connectDB();
    const clients = db.collection("Clients");

    // Ensure client exists
    let client = await clients.findOne({ clientId });
    if (!client) {
        client = { clientId, messageCount: 0, messageLimit: 1000, active: true, quotaWarningSent: false };
        await clients.insertOne(client);
    }

    // Check limit
    if (client.messageCount >= client.messageLimit) {
        return { allowed: false, messageCount: client.messageCount, messageLimit: client.messageLimit };
    }

    // Increment count
    const updated = await clients.findOneAndUpdate(
        { clientId },
        { $inc: { messageCount: 1 } },
        { returnDocument: "after" }
    );

    // ⚠️ Send warning if only 100 left
    const remaining = updated.messageLimit - updated.messageCount;

    if (remaining === 100 && !updated.quotaWarningSent) {
        await sendQuotaWarning(clientId);

        await clients.updateOne(
            { clientId },
            { $set: { quotaWarningSent: true } }
        );
    }

    return { allowed: true, messageCount: updated.messageCount, messageLimit: updated.messageLimit };
}

// ===== Conversations =====
async function getConversation(clientId, userId) {
    const db = await connectDB();
    const conversations = db.collection("Conversations");
    return await conversations.findOne({ clientId, userId });
}

async function saveConversation(clientId, userId, history, lastInteraction) {
    const db = await connectDB();
    const conversations = db.collection("Conversations");
    await conversations.updateOne(
        { clientId, userId },
        { $set: { history, lastInteraction, updatedAt: new Date() } },
        { upsert: true }
    );
}

// ===== Customers =====
async function saveCustomer(clientId, psid, userProfile) {
    const db = await connectDB();
    const customers = db.collection("Customers");

    const fullName = `${userProfile.first_name || ""} ${userProfile.last_name || ""}`.trim();

    await customers.updateOne(
        { clientId, psid },
        {
            $set: {
                clientId,
                psid,
                name: fullName || "Unknown",
                lastInteraction: new Date(),
                updatedAt: new Date(),
            },
        },
        { upsert: true }
    );
}

// ===== Users =====
async function getUserProfile(psid, pageAccessToken) {
    const url = `https://graph.facebook.com/${psid}?fields=first_name,last_name&access_token=${pageAccessToken}`;
    const res = await fetch(url);
    if (!res.ok) return { first_name: "there" }; // fallback
    return res.json();
}

// ===== Helpers =====
function isNewDay(lastDate) {
    const today = new Date();
    return (
        !lastDate ||
        lastDate.getDate() !== today.getDate() ||
        lastDate.getMonth() !== today.getMonth() ||
        lastDate.getFullYear() !== today.getFullYear()
    );
}

// ===== Webhook verification =====
router.get("/", async (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!mode || !token) {
        return res.sendStatus(403);
    }

    // Try all clients until one matches
    const db = await connectDB();
    const clients = db.collection("Clients");
    const client = await clients.findOne({ VERIFY_TOKEN: token });

    if (mode === "subscribe" && client) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ===== Messenger message handler =====
router.post("/", async (req, res) => {
    const body = req.body;

    if (body.object !== "page") {
        return res.sendStatus(404);
    }

    for (const entry of body.entry) {
        const pageId = entry.id; // treat as clientId
        const webhook_event = entry.messaging[0];
        const sender_psid = webhook_event.sender.id;

        try {
            const clientDoc = await getClientDoc(pageId);

            // ❌ Block if inactive
            if (clientDoc.active === false) {
                await sendMessengerReply(sender_psid, "⚠️ This bot is currently disabled.");
                continue;
            }

            // ✅ Check message limit
            const usage = await incrementMessageCount(pageId);
            if (!usage.allowed) {
                await sendMessengerReply(sender_psid, "⚠️ Message limit reached.");
                continue;
            }

            // 📩 Handle text message
            if (webhook_event.message?.text) {
                const userMessage = webhook_event.message.text;

                // Get system prompt
                const finalSystemPrompt = await SYSTEM_PROMPT({ clientId: pageId });

                // Load conversation
                let convo = await getConversation(pageId, sender_psid);
                let history = convo?.history || [
                    {
                        role: "system",
                        content: finalSystemPrompt
                    }
                ];

                // === New day greeting ===
                let isNewConversation = false;
                let firstName = "there";

                if (!convo || isNewDay(convo.lastInteraction)) {
                    isNewConversation = true;

                    // get user name from FB Graph
                    const userProfile = await getUserProfile(sender_psid, clientDoc.PAGE_ACCESS_TOKEN);
                    firstName = userProfile.first_name || "there";

                    // save/update customer
                    await saveCustomer(pageId, sender_psid, userProfile);

                    // send greeting + push to history
                    const greeting = `Hi ${firstName}, good to see you today 👋`;
                    await sendMessengerReply(sender_psid, greeting);
                    history.push({ role: "assistant", content: greeting, createdAt: new Date() });
                }

                // push user message
                history.push({ role: "user", content: userMessage, createdAt: new Date() });

                // Call OpenAI
                const assistantMessage = await getChatCompletion(history);

                history.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });

                // save conversation with last interaction
                await saveConversation(pageId, sender_psid, history, new Date());

                // Handle tour booking
                if (assistantMessage.includes("[TOUR_REQUEST]")) {
                    const data = extractTourData(assistantMessage);
                    data.clientId = pageId;
                    await sendTourEmail(data);
                }

                await sendMessengerReply(sender_psid, assistantMessage);
            }

            // 📌 Handle postbacks
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
        } catch (error) {
            console.error("❌ Messenger error:", error);
            await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.");
        }
    }

    res.status(200).send("EVENT_RECEIVED");
});

export default router;
