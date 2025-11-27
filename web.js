// web.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";
import crypto from "crypto";

const router = express.Router();
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== DB Connection =====
async function connectDB() {
    if (!mongoClient.topology?.isConnected?.()) {
        await mongoClient.connect();
    }
    return mongoClient.db(dbName);
}

// ===== Customers =====
async function findOrCreateCustomer(customerId, clientId) {
    const db = await connectDB();
    const customers = db.collection("Customers");

    let customer = await customers.findOne({ customerId, clientId });
    if (!customer) {
        await customers.insertOne({
            customerId,
            clientId,
            name: null,
            lastInteraction: new Date()
        });
        return null;
    } else {
        await customers.updateOne(
            { customerId, clientId },
            { $set: { lastInteraction: new Date() } }
        );
        return customer.name;
    }
}

async function updateCustomerName(customerId, clientId, name) {
    const db = await connectDB();
    const customers = db.collection("Customers");

    await customers.updateOne(
        { customerId, clientId },
        { $set: { name, lastInteraction: new Date() } }
    );
}

// ===== Conversations =====
async function getConversation(clientId, userId) {
    const db = await connectDB();
    return db.collection("Conversations").findOne({ clientId, userId });
}

async function saveConversation(clientId, userId, history) {
    const db = await connectDB();
    await db.collection("Conversations").updateOne(
        { clientId, userId, source: "web" },
        { $set: { history, updatedAt: new Date() } },
        { upsert: true }
    );
}

// ===== Clients (Message Count & Limit) =====
async function incrementMessageCount(clientId) {
    const db = await connectDB();
    const clients = db.collection("Clients");

    const updated = await clients.findOneAndUpdate(
        { clientId },
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

    const client = updated.value;

    if (client.messageCount > client.messageLimit) {
        return { allowed: false };
    }

    const remaining = client.messageLimit - client.messageCount;
    if (remaining === 100 && !client.quotaWarningSent) {
        await sendQuotaWarning(clientId);
        await clients.updateOne(
            { clientId },
            { $set: { quotaWarningSent: true } }
        );
    }

    return {
        allowed: true,
        messageCount: client.messageCount,
        messageLimit: client.messageLimit
    };
}

// =======================
//   MAIN CHAT ROUTE
// =======================
router.post("/", async (req, res) => {
    let { message: userMessage, clientId, userId, isFirstMessage, image } = req.body;
    if (!userId) userId = crypto.randomUUID();

    if (!clientId) {
        return res.status(400).json({ reply: "Missing client ID." });
    }

    try {
        const db = await connectDB();
        const clientDoc = await db.collection("Clients").findOne({ clientId });

        if (!clientDoc || clientDoc.active === false) {
            return res.status(204).end();
        }

        const usage = await incrementMessageCount(clientId);
        if (!usage.allowed) return res.json({ reply: "" });

        await findOrCreateCustomer(userId, clientId);

        // detect name
        let nameMatch = null;
        const myNameMatch = userMessage?.match(/my name is\s+(.+)/i);
        const bracketNameMatch = userMessage?.match(/\[name\]\s*:\s*(.+)/i);
        if (myNameMatch) nameMatch = myNameMatch[1].trim();
        if (bracketNameMatch) nameMatch = bracketNameMatch[1].trim();

        if (nameMatch) {
            await updateCustomerName(userId, clientId, nameMatch);
        }

        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });

        let filesContent = "";
        if (clientDoc?.files?.length) {
            filesContent = clientDoc.files
                .map(f => `File: ${f.name}\nContent:\n${f.content}`)
                .join("\n\n");
        }

        let convo = await getConversation(clientId, userId);

        let history = convo?.history || [
            {
                role: "system",
                content: `${finalSystemPrompt}\n\nClient files:\n${filesContent}`
            }
        ];

        // Build multimodal message
        let contentArray = [];

        if (userMessage) {
            contentArray.push({
                type: "input_text",
                text: userMessage
            });
        }

        if (image && image.data) {
            contentArray.push({
                type: "input_image",
                image_url: `data:${image.type};base64,${image.data}`
            });
        }

        history.push({
            role: "user",
            content: contentArray,
            createdAt: new Date()
        });

        // OpenAI multimodal processing
        const assistantMessage = await getChatCompletion(history);

        history.push({
            role: "assistant",
            content: assistantMessage,
            createdAt: new Date()
        });

        await saveConversation(clientId, userId, history);

        if (assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            data.clientId = clientId;
            try {
                await sendTourEmail(data);
            } catch (_) {}
        }

        res.json({
            reply: assistantMessage,
            userId,
            usage
        });

    } catch (err) {
        res.status(500).json({ reply: "Error occurred." });
    }
});

export default router;
