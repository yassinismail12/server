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
        console.log("🔗 Connecting to MongoDB...");
        await mongoClient.connect();
        console.log("✅ MongoDB connected");
    }
    return mongoClient.db(dbName);
}

// ===== Clients =====
async function getClientDoc(pageId) {
    const db = await connectDB();
    const clients = db.collection("Clients");
    console.log(`🔍 Fetching client document for pageId: ${pageId}`);
    let client = await clients.findOne({ pageId });

    if (!client) {
        console.log("⚠️ Client not found, creating new one");
        client = {
            pageId,  // changed from clientId to pageId
            messageCount: 0,
            messageLimit: 1000,
            active: true,
            VERIFY_TOKEN: null,
            PAGE_ACCESS_TOKEN: null,
            quotaWarningSent: false,
        };
        await clients.insertOne(client);
    }

    return client;
}

async function incrementMessageCount(pageId) {
    const db = await connectDB();
    const clients = db.collection("Clients");

    console.log(`➕ Incrementing message count for pageId: ${pageId}`);

    // Atomic upsert and increment
    const updated = await clients.findOneAndUpdate(
        { pageId },
        {
            $inc: { messageCount: 1 },
            $setOnInsert: {
                messageLimit: 1000,
                active: true,
                quotaWarningSent: false
            }
        },
        { returnDocument: "after", upsert: true }
    );

    const doc = updated.value;

    // Safety check
    if (!doc) {
        throw new Error("Failed to increment message count: doc is undefined");
    }

    // Check message limit
    if (doc.messageCount > doc.messageLimit) {
        console.log("❌ Message limit reached");
        return { allowed: false, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
    }

    const remaining = doc.messageLimit - doc.messageCount;

    // Quota warning
    if (remaining === 100 && !doc.quotaWarningSent) {
        console.log("⚠️ Only 100 messages left, sending quota warning");
        await sendQuotaWarning(pageId);
        await clients.updateOne(
            { pageId },
            { $set: { quotaWarningSent: true } }
        );
    }

    return { allowed: true, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
}


// ===== Conversations =====
async function getConversation(pageId, userId) {
    const db = await connectDB();
    console.log(`💬 Fetching conversation for pageId: ${pageId}, userId: ${userId}`);
    return await db.collection("Conversations").findOne({ pageId, userId });
}

async function saveConversation(pageId, userId, history, lastInteraction) {
    const db = await connectDB();
    console.log(`💾 Saving conversation for pageId: ${pageId}, userId: ${userId}`);
    await db.collection("Conversations").updateOne(
        { pageId, userId },
        { $set: { history, lastInteraction, updatedAt: new Date() } },
        { upsert: true }
    );
}

async function saveCustomer(pageId, psid, userProfile) {
    const db = await connectDB();
    const fullName = `${userProfile.first_name || ""} ${userProfile.last_name || ""}`.trim();
    console.log(`💾 Saving customer ${fullName} for pageId: ${pageId}`);
    await db.collection("Customers").updateOne(
        { pageId, psid },
        {
            $set: {
                pageId,
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
    console.log(`🔍 Fetching user profile for PSID: ${psid}`);
    const url = `https://graph.facebook.com/${psid}?fields=first_name,last_name&access_token=${pageAccessToken}`;
    const res = await fetch(url);
    if (!res.ok) {
        console.warn("⚠️ Failed to fetch user profile, using fallback name 'there'");
        return { first_name: "there" };
    }
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
    console.log("🔑 Webhook verification request received");

    if (!mode || !token) {
        console.warn("❌ Mode or token missing");
        return res.sendStatus(403);
    }

    const db = await connectDB();
    const client = await db.collection("Clients").findOne({ VERIFY_TOKEN: token });

    if (mode === "subscribe" && client) {
        console.log("✅ Webhook verified successfully");
        res.status(200).send(challenge);
    } else {
        console.warn("❌ Webhook verification failed");
        res.sendStatus(403);
    }
});

// ===== Messenger message handler =====
router.post("/", async (req, res) => {
    const body = req.body;
    console.log("📩 Messenger POST received", JSON.stringify(body));

    if (body.object !== "page") {
        console.warn("❌ Body object is not page");
        return res.sendStatus(404);
    }

    for (const entry of body.entry) {
        const pageId = entry.id;
        const webhook_event = entry.messaging[0];
        const sender_psid = webhook_event.sender.id;
        console.log(`📬 Event from pageId: ${pageId}, sender_psid: ${sender_psid}`);

        try {
            const clientDoc = await getClientDoc(pageId);

            if (clientDoc.active === false) {
                console.log("⚠️ Bot inactive for this page");
                await sendMessengerReply(sender_psid, "⚠️ This bot is currently disabled.");
                continue;
            }

            const usage = await incrementMessageCount(pageId);
            if (!usage.allowed) {
                console.log("⚠️ Message limit reached, not sending reply");
                await sendMessengerReply(sender_psid, "⚠️ Message limit reached.");
                continue;
            }

            if (webhook_event.message?.text) {
                const userMessage = webhook_event.message.text;
                console.log("📝 Received user message:", userMessage);

                const finalSystemPrompt = await SYSTEM_PROMPT({ pageId });
                let convo = await getConversation(pageId, sender_psid);
                let history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

                let firstName = "there";
                let greeting = "";

                // Prepare greeting but do not send separately
                if (!convo || isNewDay(convo.lastInteraction)) {
                    const userProfile = await getUserProfile(sender_psid, clientDoc.PAGE_ACCESS_TOKEN);
                    firstName = userProfile.first_name || "there";
                    await saveCustomer(pageId, sender_psid, userProfile);

                    greeting = `Hi ${firstName}, good to see you today 👋`;
                    history.push({ role: "assistant", content: greeting, createdAt: new Date() });
                }

                history.push({ role: "user", content: userMessage, createdAt: new Date() });

                const assistantMessage = await getChatCompletion(history);
                console.log("🤖 Assistant message:", assistantMessage);

                history.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
                await saveConversation(pageId, sender_psid, history, new Date());

                let combinedMessage = assistantMessage;
                if (greeting) combinedMessage = `${greeting}\n\n${assistantMessage}`;

                if (assistantMessage.includes("[TOUR_REQUEST]")) {
                    const data = extractTourData(assistantMessage);
                    data.pageId = pageId;  // changed from clientId to pageId
                    console.log("✈️ Tour request detected, sending email", data);
                    await sendTourEmail(data);
                }

                await sendMessengerReply(sender_psid, combinedMessage);
            }

            if (webhook_event.postback?.payload) {
                const payload = webhook_event.postback.payload;
                console.log("📌 Postback received:", payload);
                const responses = {
                    ICE_BREAKER_PROPERTIES: "Sure! What type of property are you looking for and in which area?",
                    ICE_BREAKER_BOOK: "You can book a visit by telling me the property you're interested in.",
                    ICE_BREAKER_PAYMENT: "Yes! We offer several payment plans. What’s your budget or preferred duration?",
                };
                if (responses[payload]) {
                    await sendMessengerReply(sender_psid, responses[payload]);
                    console.log("🤖 Sent postback response");
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
