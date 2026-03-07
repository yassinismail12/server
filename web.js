import express from "express";
import { MongoClient } from "mongodb";
import crypto from "crypto";

import { getChatCompletion } from "./services/openai.js";
import { buildRulesPrompt } from "./utils/systemPrompt.js";
import { buildChatMessages } from "./services/promptBuilder.js";
import { retrieveChunks } from "./services/retrieval.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";

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
      lastInteraction: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return null;
  }

  await customers.updateOne(
    { customerId, clientId },
    { $set: { lastInteraction: new Date(), updatedAt: new Date() } }
  );

  return customer.name;
}

async function updateCustomerName(customerId, clientId, name) {
  const db = await connectDB();
  const customers = db.collection("Customers");

  await customers.updateOne(
    { customerId, clientId },
    { $set: { name, lastInteraction: new Date(), updatedAt: new Date() } }
  );
}

// ===== Conversations =====
async function getConversation(clientId, userId) {
  const db = await connectDB();
  const conversations = db.collection("Conversations");
  return await conversations.findOne({ clientId: String(clientId), userId, source: "web" });
}

async function saveConversation(clientId, userId, history) {
  const db = await connectDB();
  const conversations = db.collection("Conversations");

  await conversations.updateOne(
    { clientId: String(clientId), userId, source: "web" },
    {
      $set: {
        clientId: String(clientId),
        userId,
        source: "web",
        history,
        updatedAt: new Date(),
        lastInteraction: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
        humanEscalation: false,
        humanRequestCount: 0,
        tourRequestCount: 0,
        orderRequestCount: 0,
      },
    },
    { upsert: true }
  );
}

// ===== Clients (Message Count & Limit) =====
async function incrementMessageCount(clientId) {
  const db = await connectDB();
  const clients = db.collection("Clients");

  const updated = await clients.findOneAndUpdate(
    { clientId: String(clientId) },
    {
      $inc: { messageCount: 1 },
      $setOnInsert: { messageLimit: 1000, active: true, quotaWarningSent: false },
      $set: { updatedAt: new Date() },
    },
    {
      returnDocument: "after",
      upsert: true,
    }
  );

  let client = updated.value;

  if (!client) {
    client = await clients.findOne({ clientId: String(clientId) });
  }

  if (!client) {
    throw new Error(`Failed to create/find client ${clientId}`);
  }

  if (client.messageCount > client.messageLimit) {
    return {
      allowed: false,
      messageCount: client.messageCount,
      messageLimit: client.messageLimit,
    };
  }

  const remaining = client.messageLimit - client.messageCount;
  if (remaining === 100 && !client.quotaWarningSent) {
    await sendQuotaWarning(clientId);
    await clients.updateOne(
      { clientId: String(clientId) },
      { $set: { quotaWarningSent: true, updatedAt: new Date() } }
    );
  }

  return {
    allowed: true,
    messageCount: client.messageCount,
    messageLimit: client.messageLimit,
  };
}

// ===== Helpers =====
function isNewDay(lastDate) {
  const today = new Date();
  const d = lastDate ? new Date(lastDate) : null;
  return (
    !d ||
    d.getDate() !== today.getDate() ||
    d.getMonth() !== today.getMonth() ||
    d.getFullYear() !== today.getFullYear()
  );
}

async function logError({ clientId, userId, source, message, meta = {} }) {
  try {
    const db = await connectDB();
    await db.collection("Logs").insertOne({
      clientId,
      userId,
      level: "error",
      source,
      message,
      meta,
      timestamp: new Date(),
    });
  } catch (dbErr) {
    console.error("❌ Failed to log error in DB:", dbErr.message);
  }
}

// ===== Route =====
router.post("/", async (req, res) => {
  let { message: userMessage, clientId, userId, isFirstMessage } = req.body;

  if (!userId) {
    userId = crypto.randomUUID();
  }

  console.log("Incoming chat request:", { clientId, userId, userMessage, isFirstMessage });

  if (!userMessage || !clientId) {
    return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
  }

  userMessage = String(userMessage).trim();

  try {
    const db = await connectDB();
    const clientsCollection = db.collection("Clients");
    const clientDoc = await clientsCollection.findOne({ clientId: String(clientId) });

    if (!clientDoc) {
      console.log(`❌ Unknown clientId: ${clientId}`);
      return res.status(204).end();
    }

    if (clientDoc.active === false) {
      console.log(`🚫 Inactive client: ${clientId}`);
      return res.status(204).end();
    }

    const usage = await incrementMessageCount(clientId);
    if (!usage.allowed) {
      return res.json({
        reply: "",
        userId,
        usage: { count: usage.messageCount, limit: usage.messageLimit },
      });
    }

    await findOrCreateCustomer(userId, clientId);

    let nameMatch = null;

    const myNameMatch = userMessage.match(/my name is\s+(.+)/i);
    if (myNameMatch) {
      nameMatch = myNameMatch[1].trim();
    }

    const bracketNameMatch = userMessage.match(/\[name\]\s*:\s*(.+)/i);
    if (bracketNameMatch) {
      nameMatch = bracketNameMatch[1].trim();
    }

    if (nameMatch) {
      await updateCustomerName(userId, clientId, nameMatch);
      console.log(`📝 Name detected and saved: ${nameMatch}`);
    }

    const convo = await getConversation(clientId, userId);
    const compactHistory = Array.isArray(convo?.history) ? convo.history : [];

    let greeting = "";
    if (isFirstMessage || !convo || isNewDay(convo.lastInteraction)) {
      const db2 = await connectDB();
      const customers = db2.collection("Customers");
      const customer = await customers.findOne({ customerId: userId, clientId: String(clientId) });

      if (customer?.name) {
        greeting = `Hi ${customer.name}, welcome back! 👋`;
      } else if (isFirstMessage) {
        greeting = "Hi 👋";
      }
    }

    const rulesPrompt = buildRulesPrompt(clientDoc);
    const botType = clientDoc?.knowledgeBotType || "default";
    const sectionsOrder =
      Array.isArray(clientDoc?.sectionsOrder) && clientDoc.sectionsOrder.length
        ? clientDoc.sectionsOrder
        : Array.isArray(clientDoc?.sectionsPresent) && clientDoc.sectionsPresent.length
        ? clientDoc.sectionsPresent
        : ["offers", "hours", "faqs", "policies", "profile", "contact", "other"];

    let grouped = {};
    try {
      grouped = await retrieveChunks({
        db,
        clientId: String(clientId),
        botType,
        userText: userMessage,
      });
    } catch (err) {
      console.error("❌ retrieveChunks error:", err.message);
      grouped = {};
      await logError({
        clientId,
        userId,
        source: "retrieval",
        message: err.message,
      });
    }

    const { messages: baseMessages, meta } = buildChatMessages({
      rulesPrompt,
      groupedChunks: grouped,
      userText: userMessage,
      sectionsOrder,
    });

    if (meta?.code) {
      console.warn("⚠️ Prompt builder warning:", meta);
    }

    const memoryTurns = compactHistory
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

    let messagesForOpenAI = baseMessages;
    if (memoryTurns.length) {
      messagesForOpenAI = [...baseMessages];
      const last = messagesForOpenAI[messagesForOpenAI.length - 1];
      if (last?.role === "user") {
        messagesForOpenAI.pop();
        messagesForOpenAI.push(...memoryTurns);
        messagesForOpenAI.push(last);
      } else {
        messagesForOpenAI.push(...memoryTurns);
      }
    }

    let assistantMessage = "";

    try {
      if (process.env.TEST_MODE === "true") {
        const delay = Math.floor(Math.random() * 300) + 100;
        await new Promise((r) => setTimeout(r, delay));

        assistantMessage = `🧪 Mock reply for ${clientId} — message: "${userMessage.slice(0, 20)}..."`;
        console.log("✅ Test mode active — skipping OpenAI call");
      } else {
        assistantMessage = await getChatCompletion(messagesForOpenAI);
      }
    } catch (err) {
      console.error("❌ OpenAI error:", err.message);

      await logError({
        clientId,
        userId,
        source: "openai",
        message: err.message,
      });

      assistantMessage = "⚠️ I'm having trouble right now. Please try again later.";
    }

    const flags = { human: false, tour: false, order: false };

    if (assistantMessage.includes("[Human_request]")) {
      flags.human = true;
      assistantMessage = assistantMessage.replace(/\[Human_request\]/g, "").trim();
    }
    if (assistantMessage.includes("[ORDER_REQUEST]")) {
      flags.order = true;
      assistantMessage = assistantMessage.replace(/\[ORDER_REQUEST\]/g, "").trim();
    }
    if (assistantMessage.includes("[TOUR_REQUEST]")) {
      flags.tour = true;
      assistantMessage = assistantMessage.replace(/\[TOUR_REQUEST\]/g, "").trim();
    }

    if (flags.human) {
      const db3 = await connectDB();
      await db3.collection("Conversations").updateOne(
        { clientId: String(clientId), userId, source: "web" },
        {
          $set: {
            humanEscalation: true,
            humanEscalationStartedAt: new Date(),
            updatedAt: new Date(),
          },
          $inc: { humanRequestCount: 1 },
        },
        { upsert: true }
      );
    }

    if (flags.tour) {
      const db3 = await connectDB();
      await db3.collection("Conversations").updateOne(
        { clientId: String(clientId), userId, source: "web" },
        {
          $inc: { tourRequestCount: 1 },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      );

      const data = extractTourData(assistantMessage);
      data.clientId = clientId;

      console.log("Sending tour email with data:", data);
      try {
        await sendTourEmail(data);
      } catch (err) {
        console.error("❌ Failed to send tour email:", err.message);
        await logError({
          clientId,
          userId,
          source: "email",
          message: err.message,
        });
      }
    }

    if (flags.order) {
      const db3 = await connectDB();
      await db3.collection("Conversations").updateOne(
        { clientId: String(clientId), userId, source: "web" },
        {
          $inc: { orderRequestCount: 1 },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      );
    }

    const combinedReply = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;

    compactHistory.push({ role: "user", content: userMessage, createdAt: new Date() });
    compactHistory.push({ role: "assistant", content: combinedReply, createdAt: new Date() });

    await saveConversation(clientId, userId, compactHistory);

    return res.json({
      reply: combinedReply,
      userId,
      usage: { count: usage.messageCount, limit: usage.messageLimit },
    });
  } catch (error) {
    console.error("❌ Error:", error.message);

    await logError({
      clientId,
      userId,
      source: "web",
      message: error.message,
    });

    return res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
  }
});

export default router;