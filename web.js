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
  if (!mongoClient.topology?.isConnected()) {
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
  const conversations = db.collection("Conversations");
  return await conversations.findOne({ clientId, userId });
}

async function saveConversation(clientId, userId, history) {
  const db = await connectDB();
  const conversations = db.collection("Conversations");
  await conversations.updateOne(
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
      $setOnInsert: { messageLimit: 1000, active: true, quotaWarningSent: false }
    },
    { returnDocument: "after", upsert: true }
  );

  let client = updated.value;
  if (!client) client = await clients.findOne({ clientId });
  if (!client) throw new Error(`Failed to create/find client ${clientId}`);

  if (client.messageCount > client.messageLimit) {
    return { allowed: false, messageCount: client.messageCount, messageLimit: client.messageLimit };
  }

  const remaining = client.messageLimit - client.messageCount;
  if (remaining === 100 && !client.quotaWarningSent) {
    await sendQuotaWarning(clientId);
    await clients.updateOne({ clientId }, { $set: { quotaWarningSent: true } });
  }

  return { allowed: true, messageCount: client.messageCount, messageLimit: client.messageLimit };
}

// ===== Route =====
router.post("/", async (req, res) => {
  let { message: userMessage, clientId, userId, isFirstMessage, image } = req.body;
  if (!userId) userId = crypto.randomUUID();

  console.log("Incoming chat request:", { clientId, userId, userMessage, isFirstMessage, image });

  if (!userMessage && !image) return res.status(400).json({ reply: "⚠️ Missing message or image." });
  if (!clientId) return res.status(400).json({ reply: "⚠️ Missing client ID." });

  try {
    const db = await connectDB();
    const clientsCollection = db.collection("Clients");
    const clientDoc = await clientsCollection.findOne({ clientId });
    if (!clientDoc || clientDoc.active === false) return res.status(204).end();

    const usage = await incrementMessageCount(clientId);
    if (!usage.allowed) return res.json({ reply: "" });

    await findOrCreateCustomer(userId, clientId);

    // Detect name
    let nameMatch = null;
    const myNameMatch = userMessage?.match(/my name is\s+(.+)/i);
    const bracketNameMatch = userMessage?.match(/\[name\]\s*:\s*(.+)/i);
    if (myNameMatch) nameMatch = myNameMatch[1].trim();
    if (bracketNameMatch) nameMatch = bracketNameMatch[1].trim();
    if (nameMatch) await updateCustomerName(userId, clientId, nameMatch);

    const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });

    // Client files content
    let filesContent = "";
    if (clientDoc?.files?.length) {
      filesContent = clientDoc.files.map(f => {
        let content = `File: ${f.name}\nContent:\n${f.content}`;
        if (f.imageURL) content += `\nImage: ${f.imageURL}`;
        return content;
      }).join("\n\n");
    }

    // Load conversation history
    let convo = await getConversation(clientId, userId);
    let greeting = "";
    if (isFirstMessage) {
      const customers = db.collection("Customers");
      const customer = await customers.findOne({ customerId: userId, clientId });
      if (customer?.name) greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
    }

    // ===== Build history for OpenAI =====
    const history = [];

    // System prompt
    history.push({ type: "input_text", text: `${finalSystemPrompt}\n\nUse the following client files:\n${filesContent}` });

    // Past conversation
    if (convo?.history?.length) {
      convo.history.forEach(h => {
        const contents = Array.isArray(h.content) ? h.content : [{ type: "input_text", text: h.content }];
        contents.forEach(c => {
          if (typeof c === "string") history.push({ type: "input_text", text: c });
          else if (c.type === "input_text" || c.type === "input_image") history.push(c);
        });
      });
    }

    // Current user message
    if (userMessage) history.push({ type: "input_text", text: userMessage });
    if (image) history.push({ type: "input_image", image_url: image });

    // ===== Call OpenAI =====
    let assistantMessage;
    try {
      if (process.env.TEST_MODE === "true") {
        const delay = Math.floor(Math.random() * 300) + 100;
        await new Promise(r => setTimeout(r, delay));
        assistantMessage = { text: userMessage ? `🧪 Mock reply: "${userMessage.slice(0,20)}..."` : "🧪 Mock image reply" };
      } else {
        assistantMessage = await getChatCompletion(history);
      }
    } catch (err) {
      console.error("❌ OpenAI error:", err.message);
      await db.collection("Logs").insertOne({
        clientId, userId, level: "error", source: "openai", message: err.message, timestamp: new Date()
      });
      assistantMessage = { text: "⚠️ I'm having trouble right now. Please try again later." };
    }

    // ===== Save assistant reply =====
    const assistantContent = [];
    if (assistantMessage.text) assistantContent.push({ type: "input_text", text: assistantMessage.text });
    if (assistantMessage.images?.length) assistantMessage.images.forEach(url => assistantContent.push({ type: "input_image", image_url: url }));

    convo?.history?.push({ role: "assistant", content: assistantContent });
    await saveConversation(clientId, userId, convo?.history || [{ role: "assistant", content: assistantContent }]);

    // ===== Format reply =====
    let formattedReply = assistantMessage.text || "";
    if (assistantMessage.images?.length) {
      formattedReply += "\n" + assistantMessage.images.map(url =>
        `<img src="${url}" style="max-width:100%; border-radius:8px; margin:4px 0;" />`
      ).join("\n");
    }

    // ===== TOUR_REQUEST handling =====
    if (assistantMessage.text?.includes("[TOUR_REQUEST]")) {
      const data = extractTourData(assistantMessage.text);
      data.clientId = clientId;
      try { await sendTourEmail(data); } catch (err) { console.error(err); }
    }

    res.json({
      reply: greeting + formattedReply,
      userId,
      usage: { count: usage.messageCount, limit: usage.messageLimit }
    });

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
  }
});

export default router;
