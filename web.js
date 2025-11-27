// web.js
import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";
import crypto from "crypto";
import sharp from "sharp";

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
      lastInteraction: new Date(),
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
  await db.collection("Customers").updateOne(
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
        quotaWarningSent: false,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  let client = updated.value;
  if (!client) {
    client = await clients.findOne({ clientId });
  }

  if (!client || client.messageCount === undefined) {
    throw new Error("Client document missing after update");
  }

  if (client.messageCount > client.messageLimit) return { allowed: false };

  const remaining = client.messageLimit - client.messageCount;
  if (remaining === 100 && !client.quotaWarningSent) {
    await sendQuotaWarning(clientId);
    await clients.updateOne({ clientId }, { $set: { quotaWarningSent: true } });
  }

  return {
    allowed: true,
    messageCount: client.messageCount,
    messageLimit: client.messageLimit,
  };
}

// ===== Image Resizing =====
async function resizeBase64Image(base64) {
  const matches = base64.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) return null;

  const data = Buffer.from(matches[2], "base64");
  const resizedBuffer = await sharp(data)
    .resize({ width: 512, withoutEnlargement: true })
    .toFormat("png")
    .toBuffer();

  return `data:image/png;base64,${resizedBuffer.toString("base64")}`;
}

// =======================
//   MAIN CHAT ROUTE
// =======================
router.post("/", async (req, res) => {
  let { message: userMessage, clientId, userId, isFirstMessage, image } = req.body;
  if (!userId) userId = crypto.randomUUID();

  console.log("Incoming chat request:", { clientId, userId, userMessage, isFirstMessage });

  if (!userMessage && !image) return res.status(400).json({ reply: "⚠️ Missing message or image." });
  if (!clientId) return res.status(400).json({ reply: "⚠️ Missing client ID." });

  try {
    const db = await connectDB();
    const clientDoc = await db.collection("Clients").findOne({ clientId });

    if (!clientDoc) return res.status(403).json({ error: "Invalid clientId" });
    if (!clientDoc.active) return res.status(403).json({ error: "Client is inactive" });

    const usage = await incrementMessageCount(clientId);
    if (!usage.allowed) return res.json({ reply: "" });

    await findOrCreateCustomer(userId, clientId);

    // ===== Name detection =====
    const nameMatch =
      userMessage?.match(/my name is\s+(.+)/i)?.[1]?.trim() ||
      userMessage?.match(/\[name\]\s*:\s*(.+)/i)?.[1]?.trim();
    if (nameMatch) await updateCustomerName(userId, clientId, nameMatch);

    // ===== System prompt + client files =====
    const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });
    const filesContent = clientDoc?.files?.length
      ? clientDoc.files.map(f => `File: ${f.name}\nContent:\n${f.content}`).join("\n\n")
      : "";

    // ===== Load conversation =====
    const convo = await getConversation(clientId, userId);
    let greeting = "";
    if (isFirstMessage) {
      const customer = await db.collection("Customers").findOne({ customerId: userId, clientId });
      if (customer?.name) greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
    }

    let history = convo?.history || [
      {
        role: "system",
        content: [
          { type: "text", text: `${finalSystemPrompt}\n\nUse the following client files:\n${filesContent}` }
        ]
      }
    ];

    // ===== User message payload =====
    const contentPayload = [];
    if (userMessage) contentPayload.push({ type: "text", text: userMessage });

    // ===== Handle base64 image =====
    if (image && typeof image === "string" && image.startsWith("data:image")) {
      try {
        const resized = await resizeBase64Image(image);
        contentPayload.push({
          type: "input_image",
          image_url: resized || "https://your-server.com/placeholder.png"
        });
      } catch (err) {
        console.warn("🚨 Image resize failed, using placeholder:", err.message);
        contentPayload.push({ type: "input_image", image_url: "https://your-server.com/placeholder.png" });
      }
    }

    // ===== Multipart file uploads =====
    if (req.files?.length) {
      for (const file of req.files) {
        const base64 = file.buffer.toString("base64");
        contentPayload.push({ type: "input_image", image_url: `data:${file.mimetype};base64,${base64}` });
      }
    }

    // Push user message
    history.push({ role: "user", content: contentPayload, createdAt: new Date() });

 
    // ===== OpenAI call =====
    let assistantMessage;
    try {
      if (process.env.TEST_MODE === "true") {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 300) + 100));
        assistantMessage = "🧪 Mock reply (image supported)";
      } else {
        assistantMessage = await getChatCompletion(history);
      }
    } catch (err) {
      console.error("❌ OpenAI error:", err.message);
      await db.collection("Logs").insertOne({
        clientId,
        userId,
        level: "error",
        source: "openai",
        message: err.message,
        timestamp: new Date(),
      });
      assistantMessage = "⚠️ I'm having trouble right now.";
    }

    // ===== Save assistant message =====
    history.push({
      role: "assistant",
      content: [{ type: "text", text: assistantMessage }],
      createdAt: new Date(),
    });

    await saveConversation(clientId, userId, history);

    // ===== Tour booking =====
    if (assistantMessage?.includes("[TOUR_REQUEST]")) {
      const data = extractTourData(assistantMessage);
      data.clientId = clientId;
      try {
        await sendTourEmail(data);
      } catch (err) {
        console.error("❌ Failed to send tour email:", err.message);
        await db.collection("Logs").insertOne({
          clientId,
          userId,
          level: "error",
          source: "email",
          message: err.message,
          timestamp: new Date(),
        });
      }
    }

    return res.json({
      reply: greeting + assistantMessage,
      userId,
      usage: { count: usage.messageCount, limit: usage.messageLimit },
    });

  } catch (error) {
    console.error("❌ Error:", error.message);
    try {
      const db = await connectDB();
      await db.collection("Logs").insertOne({
        clientId,
        userId,
        level: "error",
        source: "web",
        message: error.message,
        timestamp: new Date(),
      });
    } catch (dbErr) {
      console.error("❌ DB log failed:", dbErr.message);
    }
    res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
  }
});

export default router;
