// web.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";

import { getChatCompletion } from "./services/openai.js";
import { buildRulesPrompt } from "./utils/systemPrompt.js";
import { buildChatMessages } from "./services/promptBuilder.js";
import { retrieveChunks } from "./services/retrieval.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";

const router = express.Router();

// ✅ Reuse mongoose connection — never open a second MongoClient
function getDB() {
  return mongoose.connection.db;
}

// ===============================
// Logging
// ===============================
function log(level, msg, meta = {}) {
  const base = { t: new Date().toISOString(), msg, ...meta };
  if (level === "error") console.error("❌", base);
  else if (level === "warn") console.warn("⚠️", base);
  else console.log("ℹ️", base);
}

async function logToDb(level, source, message, meta = {}) {
  try {
    const db = getDB();
    await db.collection("Logs").insertOne({
      level, source, message, meta,
      timestamp: new Date(),
    });
  } catch (e) {
    console.warn("⚠️ Failed to write log to DB:", e.message);
  }
}

// ===============================
// Helpers
// ===============================
function detectUserLanguage(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || "")) ? "ar" : "en";
}

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

// ===============================
// History injection — same pattern as messenger.js
// ===============================
function buildRecentHistoryMessages(history = [], limit = 12) {
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
}

function injectHistoryIntoMessages(baseMessages = [], history = []) {
  const historyMessages = buildRecentHistoryMessages(history, 12);
  if (!historyMessages.length) return baseMessages;

  const msgs = Array.isArray(baseMessages) ? [...baseMessages] : [];
  if (!msgs.length) return historyMessages;

  const systemMessages = [];
  const nonSystemMessages = [];

  for (const msg of msgs) {
    if (msg?.role === "system") systemMessages.push(msg);
    else nonSystemMessages.push(msg);
  }

  const last = nonSystemMessages[nonSystemMessages.length - 1];
  const hasCurrentUserAtEnd = last?.role === "user";

  if (hasCurrentUserAtEnd) {
    return [
      ...systemMessages,
      ...nonSystemMessages.slice(0, -1),
      ...historyMessages,
      last,
    ];
  }

  return [...systemMessages, ...historyMessages, ...nonSystemMessages];
}

// ===============================
// Customers
// ===============================
async function findOrCreateCustomer(userId, clientId) {
  const db = getDB();
  const customers = db.collection("Customers");

  const customer = await customers.findOne({
    customerId: userId,
    clientId: String(clientId),
  });

  if (!customer) {
    await customers.insertOne({
      customerId: userId,
      clientId: String(clientId),
      name: null,
      lastInteraction: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return null;
  }

  await customers.updateOne(
    { customerId: userId, clientId: String(clientId) },
    { $set: { lastInteraction: new Date(), updatedAt: new Date() } }
  );

  return customer.name || null;
}

async function updateCustomerName(userId, clientId, name) {
  const db = getDB();
  await db.collection("Customers").updateOne(
    { customerId: userId, clientId: String(clientId) },
    { $set: { name, lastInteraction: new Date(), updatedAt: new Date() } }
  );
}

// ===============================
// Conversations
// ===============================
async function getConversation(clientId, userId) {
  const db = getDB();
  return db.collection("Conversations").findOne({
    clientId: String(clientId),
    userId,
    source: "web",
  });
}

async function saveConversation(clientId, userId, history) {
  const db = getDB();
  await db.collection("Conversations").updateOne(
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

// ===============================
// Message quota
// ===============================
async function incrementMessageCount(clientId) {
  const db = getDB();
  const clients = db.collection("Clients");
  const cid = String(clientId);

  const updateRes = await clients.updateOne(
    { clientId: cid },
    {
      $inc: { messageCount: 1 },
      $set: { updatedAt: new Date() },
    }
  );

  if (!updateRes.matchedCount) {
    log("warn", "incrementMessageCount: client not found", { clientId: cid });
    return { allowed: false, reason: "client_not_found" };
  }

  const doc = await clients.findOne({ clientId: cid });
  if (!doc) return { allowed: false, reason: "client_not_found" };

  const messageLimit = doc.messageLimit ?? 1000;
  const messageCount = doc.messageCount ?? 0;

  if (messageCount > messageLimit) {
    log("warn", "Message limit reached", { clientId: cid, messageCount, messageLimit });
    return { allowed: false, messageCount, messageLimit, reason: "quota_exceeded" };
  }

  const remaining = messageLimit - messageCount;
  if (remaining === 100 && !doc.quotaWarningSent) {
    await sendQuotaWarning(cid);
    await clients.updateOne(
      { clientId: cid },
      { $set: { quotaWarningSent: true, updatedAt: new Date() } }
    );
  }

  return { allowed: true, messageCount, messageLimit };
}

// ===============================
// Route
// ===============================
router.post("/", async (req, res) => {
  let { message: userMessage, clientId, userId, isFirstMessage } = req.body;

  if (!userId) userId = crypto.randomUUID();

  log("info", "Incoming web chat request", {
    clientId,
    userId,
    preview: String(userMessage || "").slice(0, 80),
    isFirstMessage,
  });

  if (!userMessage || !clientId) {
    return res.status(400).json({ reply: "⚠️ Missing message or client ID." });
  }

  userMessage = String(userMessage).trim();

  try {
    const db = getDB();
    const clientDoc = await db.collection("Clients").findOne({ clientId: String(clientId) });

    if (!clientDoc) {
      log("warn", "Unknown clientId", { clientId });
      return res.status(204).end();
    }

    if (clientDoc.active === false) {
      log("info", "Inactive client", { clientId });
      return res.status(204).end();
    }

    // ── Quota check ──────────────────────────────────────────────────────────
    const usage = await incrementMessageCount(clientId);
    if (!usage.allowed) {
      if (usage.reason === "client_not_found") return res.status(204).end();
      return res.json({
        reply: "",
        userId,
        usage: { count: usage.messageCount, limit: usage.messageLimit },
      });
    }

    // ── Customer ─────────────────────────────────────────────────────────────
    const savedName = await findOrCreateCustomer(userId, clientId);

    // Detect name from message
    let nameMatch = null;
    const myNameMatch = userMessage.match(/my name is\s+(.+)/i);
    if (myNameMatch) nameMatch = myNameMatch[1].trim();
    const bracketNameMatch = userMessage.match(/\[name\]\s*:\s*(.+)/i);
    if (bracketNameMatch) nameMatch = bracketNameMatch[1].trim();
    if (nameMatch) {
      await updateCustomerName(userId, clientId, nameMatch);
      log("info", "Name detected and saved", { name: nameMatch });
    }

    // ── Conversation history ─────────────────────────────────────────────────
    const convo = await getConversation(clientId, userId);
    const compactHistory = Array.isArray(convo?.history) ? convo.history : [];

    // ── Greeting ─────────────────────────────────────────────────────────────
    let greeting = "";
    if (isFirstMessage || !convo || isNewDay(convo?.lastInteraction)) {
      const customerName = nameMatch || savedName || null;
      const userLang = detectUserLanguage(userMessage);

      if (customerName) {
        greeting = userLang === "ar"
          ? `أهلًا ${customerName}، سعيدين بوجودك 👋`
          : `Hi ${customerName}, welcome back! 👋`;
      } else {
        greeting = userLang === "ar" ? "أهلًا 👋" : "Hi 👋";
      }
    }

    // ── Build prompt config ──────────────────────────────────────────────────
    const rulesPrompt = buildRulesPrompt(clientDoc);
    const botType = clientDoc?.knowledgeBotType || "default";
    const sectionsOrder =
      Array.isArray(clientDoc?.sectionsOrder) && clientDoc.sectionsOrder.length
        ? clientDoc.sectionsOrder
        : Array.isArray(clientDoc?.sectionsPresent) && clientDoc.sectionsPresent.length
        ? clientDoc.sectionsPresent
        : ["offers", "hours", "faqs", "policies", "profile", "contact", "other"];

    // ── Retrieve chunks ──────────────────────────────────────────────────────
    let grouped = {};
    try {
      grouped = await retrieveChunks({
        clientId: String(clientId),
        botType,
        userText: userMessage,
        retrievalQuery: userMessage,
        maxChunks: 8,
      });
    } catch (err) {
      log("warn", "retrieveChunks error", { clientId, err: err.message });
      await logToDb("warn", "retrieval", err.message, { clientId, userId });
    }

    // ── Build messages ───────────────────────────────────────────────────────
    const { messages: baseMessages, meta: promptMeta } = buildChatMessages({
      rulesPrompt,
      groupedChunks: grouped,
      userText: userMessage,
      sectionsOrder,
    });

    if (promptMeta?.code) {
      log("warn", "Prompt builder warning", { clientId, userId, meta: promptMeta });
    }

    // ✅ Inject conversation history same way as messenger.js
    const messagesForOpenAI = injectHistoryIntoMessages(baseMessages, compactHistory);

    // ── OpenAI call ──────────────────────────────────────────────────────────
    let assistantMessage = "";
    try {
      if (process.env.TEST_MODE === "true") {
        await new Promise((r) => setTimeout(r, 150));
        assistantMessage = `🧪 Mock reply for ${clientId} — "${userMessage.slice(0, 30)}..."`;
        log("info", "Test mode — skipping OpenAI");
      } else {
        assistantMessage = await getChatCompletion(messagesForOpenAI);
      }
    } catch (err) {
      log("error", "OpenAI error", { clientId, userId, err: err.message });
      await logToDb("error", "openai", err.message, { clientId, userId });
      assistantMessage = "⚠️ I'm having trouble right now. Please try again shortly.";
    }

    // ── Flag detection ───────────────────────────────────────────────────────
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

    // ── Human escalation ─────────────────────────────────────────────────────
    if (flags.human) {
      await db.collection("Conversations").updateOne(
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

      log("warn", "Web human escalation triggered", { clientId, userId });
    }

    // ── Tour flow ─────────────────────────────────────────────────────────────
    if (flags.tour) {
      await db.collection("Conversations").updateOne(
        { clientId: String(clientId), userId, source: "web" },
        {
          $inc: { tourRequestCount: 1 },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      );

      try {
        const tourData = extractTourData(assistantMessage);
        tourData.clientId = clientId;
        await sendTourEmail(tourData);
        log("info", "Tour email sent", { clientId, userId });
      } catch (err) {
        log("warn", "Tour email failed", { clientId, userId, err: err.message });
        await logToDb("warn", "email", err.message, { clientId, userId });
      }
    }

    // ── Order flow ─────────────────────────────────────────────────────────────
    if (flags.order) {
      await db.collection("Conversations").updateOne(
        { clientId: String(clientId), userId, source: "web" },
        {
          $inc: { orderRequestCount: 1 },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      );

      log("info", "Web order flag triggered", { clientId, userId });
    }

    // ── Build final reply ────────────────────────────────────────────────────
    const combinedReply = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;

    // ── Save conversation ────────────────────────────────────────────────────
    compactHistory.push({ role: "user", content: userMessage, createdAt: new Date() });
    compactHistory.push({ role: "assistant", content: combinedReply, createdAt: new Date() });
    await saveConversation(clientId, userId, compactHistory);

    return res.json({
      reply: combinedReply,
      userId,
      usage: { count: usage.messageCount, limit: usage.messageLimit },
    });

  } catch (error) {
    log("error", "Web chat handler error", { clientId, userId, err: error.message });
    await logToDb("error", "web", error.message, { clientId, userId });
    return res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
  }
});

export default router;