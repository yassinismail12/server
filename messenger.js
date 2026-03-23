// messenger.js
import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";
import crypto from "crypto";

import { retrieveChunks } from "./services/retrieval.js";
import { buildChatMessages } from "./services/promptBuilder.js";

import { getChatCompletion } from "./services/openai.js";
import { buildRulesPrompt } from "./utils/systemPrompt.js";
import { sendMessengerReply, sendMarkAsRead } from "./services/messenger.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { connectToDB as connectDB } from "./services/db.js";
import Order from "./order.js";
import { notifyClientStaffNewOrderByClientId } from "./utils/notifyClientStaffWhatsApp.js";
import { notifyClientStaffHumanNeeded } from "./utils/notifyClientStaffHumanNeeded.js";
import { enqueueMessengerMessage } from "./queue.js";
const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";
let mongoConnected = false;

// ===============================
// Logging helpers
// ===============================
function log(level, msg, meta = {}) {
  const base = { level, msg, t: new Date().toISOString(), ...meta };
  if (level === "error") console.error("❌", msg, meta);
  else if (level === "warn") console.warn("⚠️", msg, meta);
  else console.log("ℹ️", msg, meta);
  return base;
}

async function logToDb(level, source, message, meta = {}) {
  try {
    const db = await connectDB();
    await db.collection("Logs").insertOne({
      level,
      source,
      message,
      meta,
      timestamp: new Date(),
    });
  } catch (e) {
    console.warn("⚠️ Failed to write log to DB:", e.message);
  }
}

// ===============================
// Normalizers
// ===============================
function normalizePageId(id) {
  return String(id || "").trim();
}
function normalizePsid(id) {
  return String(id || "").trim();
}
function normalizeToken(t) {
  return String(t || "").trim();
}

// ===============================
// DB
// ===============================
async function ensureIndexes(db) {
  try {
    const processed = db.collection("ProcessedEvents");
    await processed.createIndex({ pageId: 1, eventKey: 1 }, { unique: true });
    await processed.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

    const convos = db.collection("Conversations");
    await convos.createIndex({ pageId: 1, userId: 1, source: 1 });
  } catch (e) {
    console.warn("⚠️ ensureIndexes failed:", e.message);
  }
}



// ===============================
// Idempotency (Meta retries webhooks)
// ===============================
function buildEventKey(webhook_event) {
  const mid =
    webhook_event?.message?.mid ||
    webhook_event?.postback?.mid ||
    webhook_event?.delivery?.mids?.[0];

  if (mid) return `mid:${String(mid).trim()}`;

  const sender = webhook_event?.sender?.id ? String(webhook_event.sender.id).trim() : "";
  const ts = webhook_event?.timestamp ? String(webhook_event.timestamp).trim() : "";
  const text = webhook_event?.message?.text ? String(webhook_event.message.text).slice(0, 80) : "";
  if (sender && ts) return `fallback:${sender}:${ts}:${text}`;

  return "";
}

async function wasProcessed(pageId, eventKey) {
  if (!eventKey) return false;
  const db = await connectDB();
  const existing = await db.collection("ProcessedEvents").findOne({
    pageId: normalizePageId(pageId),
    eventKey: String(eventKey),
  });
  return Boolean(existing);
}

async function markProcessed(pageId, eventKey, meta = {}) {
  if (!eventKey) return;
  const db = await connectDB();
  try {
    await db.collection("ProcessedEvents").insertOne({
      pageId: normalizePageId(pageId),
      eventKey: String(eventKey),
      createdAt: new Date(),
      meta,
    });
  } catch {
    // ignore duplicate key errors
  }
}

// ===============================
// Clients (NO auto-create from webhook)
// ===============================
function newClientId() {
  return crypto.randomUUID();
}

async function getClientByPageId(pageId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const pageIdStr = normalizePageId(pageId);

  const client = await clients.findOne({ pageId: pageIdStr });
  if (!client) return null;

  if (!client.clientId) {
    const cid = newClientId();
    await clients.updateOne(
      { pageId: pageIdStr },
      { $set: { clientId: cid, updatedAt: new Date() } }
    );
    client.clientId = cid;
    log("warn", "Client missing clientId; backfilled", { pageId: pageIdStr, clientId: cid });
  }

  return client;
}

async function incrementMessageCountForClient(pageId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const pageIdStr = normalizePageId(pageId);

  const updateRes = await clients.updateOne(
    { pageId: pageIdStr },
    { $inc: { messageCount: 1 }, $set: { updatedAt: new Date() } }
  );

  if (!updateRes.matchedCount) {
    log("warn", "incrementMessageCount: client not found; skipping", { pageId: pageIdStr });
    return { allowed: false, reason: "client_not_found" };
  }

  const doc = await clients.findOne({ pageId: pageIdStr });
  if (!doc) return { allowed: false, reason: "client_not_found" };

  if (!doc.clientId) {
    const cid = newClientId();
    await clients.updateOne(
      { pageId: pageIdStr },
      { $set: { clientId: cid, updatedAt: new Date() } }
    );
    doc.clientId = cid;
  }

  const messageLimit = doc.messageLimit ?? 1000;
  const messageCount = doc.messageCount ?? 0;

  if (messageCount > messageLimit) {
    log("warn", "Message limit reached for pageId", { pageId: pageIdStr, messageCount, messageLimit });
    return { allowed: false, messageCount, messageLimit, reason: "quota_exceeded" };
  }

  const remaining = messageLimit - messageCount;

  if (remaining === 100 && !doc.quotaWarningSent) {
    log("warn", "Only 100 messages left for pageId", { pageId: pageIdStr });
    await sendQuotaWarning(pageIdStr);
    await clients.updateOne(
      { pageId: pageIdStr },
      { $set: { quotaWarningSent: true, updatedAt: new Date() } }
    );
  }

  return { allowed: true, messageCount, messageLimit };
}
function detectUserLanguage(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || "")) ? "ar" : "en";
}
// ===============================
// Conversation
// ===============================
async function getConversation(pageId, userId, source = "messenger") {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);
  return db.collection("Conversations").findOne({ pageId: pageIdStr, userId, source });
}

async function saveConversation(pageId, userId, history, lastInteraction, source = "messenger") {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);

  const client = await db.collection("Clients").findOne({ pageId: pageIdStr });
  if (!client) {
    log("warn", "saveConversation: client not found; skipping", { pageId: pageIdStr });
    await logToDb("warn", source, "saveConversation: client not found; skipping", { pageId: pageIdStr });
    return;
  }

  let clientId = client.clientId;
  if (!clientId) {
    clientId = newClientId();
    await db.collection("Clients").updateOne(
      { pageId: pageIdStr },
      { $set: { clientId, updatedAt: new Date() } }
    );
  }

  await db.collection("Conversations").updateOne(
    { pageId: pageIdStr, userId, source },
    {
      $set: {
        pageId: pageIdStr,
        clientId,
        history,
        lastInteraction,
        source,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        humanEscalation: false,
        humanRequestCount: 0,
        tourRequestCount: 0,
        orderRequestCount: 0,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

async function resumeConversationByStaff({ pageId, userId, resumedBy = "dashboard" }) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);
  const userIdStr = normalizePsid(userId);

  if (!pageIdStr || !userIdStr) {
    throw new Error("Missing pageId or userId");
  }

  await db.collection("Conversations").updateOne(
    { pageId: pageIdStr, userId: userIdStr, source: "messenger" },
    {
      $set: {
        pageId: pageIdStr,
        userId: userIdStr,
        source: "messenger",
        humanEscalation: false,
        botResumeAt: null,
        resumedBy,
        resumedAt: new Date(),
        updatedAt: new Date(),
      },
      $setOnInsert: {
        history: [],
        lastInteraction: new Date(),
        humanRequestCount: 0,
        tourRequestCount: 0,
        orderRequestCount: 0,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  return { ok: true, pageId: pageIdStr, userId: userIdStr };
}

// ===============================
// Customers
// ===============================
async function saveCustomer(pageId, psid, userProfile) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);
  const fullName = `${userProfile.first_name || ""} ${userProfile.last_name || ""}`.trim();

  await db.collection("Customers").updateOne(
    { pageId: pageIdStr, psid },
    {
      $set: {
        pageId: pageIdStr,
        psid,
        name: fullName || "Unknown",
        lastInteraction: new Date(),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

// ===============================
// User profile fetch (PSID)
// ===============================
async function getUserProfile(psid, pageAccessToken, meta = {}) {
  const safePsid = normalizePsid(psid);

  if (!pageAccessToken) {
    log("warn", "PAGE_ACCESS_TOKEN missing; cannot fetch user profile", { ...meta });
    await logToDb("warn", "graph", "PAGE_ACCESS_TOKEN missing; cannot fetch user profile", { ...meta });
    return { first_name: "there" };
  }

  const url = new URL(`https://graph.facebook.com/v20.0/${safePsid}`);
  url.searchParams.set("fields", "first_name,last_name");
  url.searchParams.set("access_token", pageAccessToken);

  let res;
  try {
    res = await fetch(url.toString());
  } catch (e) {
    log("error", "Graph fetch failed (network)", { ...meta, err: e.message });
    await logToDb("error", "graph", "Graph fetch failed (network)", { ...meta, err: e.message });
    return { first_name: "there" };
  }

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    log("warn", "Graph profile fetch failed", {
      ...meta,
      status: res.status,
      response: text?.slice(0, 1000),
      psid: safePsid,
    });

    await logToDb("warn", "graph", "Graph profile fetch failed", {
      ...meta,
      status: res.status,
      response: text?.slice(0, 2000),
      psid: safePsid,
    });

    return { first_name: "there" };
  }

  try {
    return JSON.parse(text);
  } catch {
    log("warn", "Graph profile fetch: non-JSON response", { ...meta, response: text?.slice(0, 500) });
    return { first_name: "there" };
  }
}

// ===============================
// Helpers
// ===============================
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

function extractLineValue(text, label) {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)\\s*$`, "im");
  const m = String(text || "").match(re);
  return m ? m[1].trim() : "";
}

function waSafeParam(text) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{5,}/g, "    ")
    .trim()
    .slice(0, 1024);
}

// ✅ NEW: keep only clean recent history and inject it into OpenAI messages
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
    .map((m) => ({
      role: m.role,
      content: m.content.trim(),
    }));
}

function injectHistoryIntoMessages(baseMessages = [], history = []) {
  const historyMessages = buildRecentHistoryMessages(history, 12);
  if (!historyMessages.length) return baseMessages;

  const msgs = Array.isArray(baseMessages) ? [...baseMessages] : [];
  if (!msgs.length) return historyMessages;

  // keep system message(s) at the top
  const systemMessages = [];
  const nonSystemMessages = [];

  for (const msg of msgs) {
    if (msg?.role === "system") systemMessages.push(msg);
    else nonSystemMessages.push(msg);
  }

  // If promptBuilder already put the current user message last,
  // place history BEFORE that last current user message.
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
// Order flow
// ===============================
async function createOrderFlow({
  pageId,
  sender_psid,
  orderSummaryText,
  channel = "messenger",
}) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);

  const client = await db.collection("Clients").findOne({ pageId: pageIdStr });
  if (!client) {
    throw new Error(`Client not found for pageId=${pageIdStr}`);
  }

  const customer = await db.collection("Customers").findOne({
    pageId: pageIdStr,
    psid: sender_psid,
  });

  const nameFromAi = extractLineValue(orderSummaryText, "Customer Name");
  const phoneFromAi = extractLineValue(orderSummaryText, "Customer Phone");
  const notesFromAi = extractLineValue(orderSummaryText, "Notes");
  const deliveryFromAi = extractLineValue(orderSummaryText, "Delivery Info");
  const itemsFromAi = extractLineValue(orderSummaryText, "Items");

  const customerName = nameFromAi || customer?.name || "Unknown";
  const customerPhone = phoneFromAi || customer?.phone || "N/A";
  const itemsText = itemsFromAi || orderSummaryText;

  const combinedNotes = [
    deliveryFromAi ? `Delivery Info: ${deliveryFromAi}` : null,
    notesFromAi ? `Notes: ${notesFromAi}` : "Notes: None",
  ]
    .filter(Boolean)
    .join(" | ");

  const fallbackOrderId = `ORD-${Date.now()}`;

  const notifyResult = await notifyClientStaffNewOrderByClientId({
    clientId: client.clientId,
    payload: {
      customerName: waSafeParam(customerName),
      customerPhone: waSafeParam(customerPhone),
      itemsText: waSafeParam(itemsText),
      notes: waSafeParam(combinedNotes),
      orderId: waSafeParam(fallbackOrderId),
      channel,
    },
  });

  log("info", "WhatsApp notify result", {
    pageId: pageIdStr,
    clientId: client.clientId,
    notifyResult,
  });

  try {
    const order = await Order.create({
      clientId: client.clientId,
      channel,
      customer: {
        name: customerName,
        phone: customerPhone === "N/A" ? "" : customerPhone,
        externalUserId: sender_psid,
      },
      itemsText: orderSummaryText,
      notes: combinedNotes,
      status: "new",
    });

    log("info", "Order saved", {
      pageId: pageIdStr,
      clientId: client.clientId,
      orderId: String(order._id),
    });

    return { order, notifyResult };
  } catch (e) {
    log("warn", "Order save failed (WhatsApp already sent)", {
      pageId: pageIdStr,
      clientId: client.clientId,
      err: e.message,
    });

    await logToDb("warn", "order", "Order save failed (WhatsApp already sent)", {
      pageId: pageIdStr,
      clientId: client.clientId,
      err: e.message,
    });

    return { order: null, notifyResult };
  }
}
// ===============================
// Webhook verification (DB VERIFY_TOKEN)
// ===============================
router.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = normalizeToken(req.query["hub.verify_token"]);
  const challenge = req.query["hub.challenge"];

  if (!mode || !token) {
    log("warn", "Webhook verification missing mode/token");
    return res.sendStatus(403);
  }

  const db = await connectDB();
  const client = await db.collection("Clients").findOne({ VERIFY_TOKEN: token });

  if (mode === "subscribe" && client) {
    log("info", "Webhook verified", { pageId: client.pageId, clientId: client.clientId });
    return res.status(200).send(challenge);
  }

  log("warn", "Webhook verification failed", { mode, tokenProvided: true });
  return res.sendStatus(403);
});

// ===============================
// Manual per-conversation resume
// ===============================
router.post("/resume-conversation", express.json(), async (req, res) => {
  try {
    const pageId = normalizePageId(req.body?.pageId);
    const userId = normalizePsid(req.body?.userId);

    if (!pageId || !userId) {
      return res.status(400).json({ ok: false, error: "Missing pageId or userId" });
    }

    const result = await resumeConversationByStaff({
      pageId,
      userId,
      resumedBy: "dashboard",
    });

    log("info", "Conversation resumed manually", result);
    return res.json(result);
  } catch (e) {
    log("error", "resume-conversation failed", { err: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===============================
// Messenger webhook receiver
// ===============================
router.post("/", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry || []) {
    const pageId = normalizePageId(entry.id);

    const clientForEntry = await getClientByPageId(pageId);
    if (!clientForEntry) {
      log("warn", "Webhook event for unknown pageId; ignoring", { pageId });
      await logToDb("warn", "messenger", "Webhook event for unknown pageId; ignoring", { pageId });
      continue;
    }
    if (clientForEntry.active === false) continue;

    try {
      const db = await connectDB();
      await db.collection("Clients").updateOne(
        { pageId },
        { $set: { lastWebhookAt: new Date(), updatedAt: new Date() } }
      );
    } catch {}

    const events = entry.messaging || [];
    for (const webhook_event of events) {
      const sender_psid = normalizePsid(webhook_event?.sender?.id);
      const recipient_page_id = normalizePageId(webhook_event?.recipient?.id);

      const metaBase = {
        pageId,
        recipientPageId: recipient_page_id,
        psid: sender_psid,
        hasMessage: Boolean(webhook_event?.message),
        hasPostback: Boolean(webhook_event?.postback),
        isEcho: Boolean(webhook_event?.message?.is_echo),
      };

      if (recipient_page_id && recipient_page_id !== pageId) {
        log("warn", "PageId mismatch between entry.id and recipient.id", metaBase);
        await logToDb("warn", "messenger", "PageId mismatch between entry.id and recipient.id", metaBase);
      }

      const eventKey = buildEventKey(webhook_event);
      if (eventKey && (await wasProcessed(pageId, eventKey))) {
        log("info", "Skipping duplicate webhook event", { ...metaBase, eventKey });
        continue;
      }
      await markProcessed(pageId, eventKey, metaBase);

      try {
        const clientDoc = await getClientByPageId(pageId);
        if (!clientDoc) continue;
        if (clientDoc.active === false) continue;

        if (!clientDoc.PAGE_ACCESS_TOKEN) {
          log("warn", "Client has no PAGE_ACCESS_TOKEN", { ...metaBase, clientPageId: clientDoc.pageId });
          await logToDb("warn", "messenger", "Client has no PAGE_ACCESS_TOKEN", {
            ...metaBase,
            clientPageId: clientDoc.pageId,
          });
        }

        if (webhook_event.message?.is_echo === true) {
          log("info", "Skipping messenger echo event", metaBase);
          continue;
        }

        if (webhook_event.message?.attachments?.length > 0) {
          await sendMessengerReply(
            sender_psid,
            "Could you describe what's in the image, or say the name of the item u are looking for so I can help you better?",
            pageId
          );
          continue;
        }

        if (webhook_event.message?.text) {
          const userMessage = webhook_event.message.text;
          const db = await connectDB();
          const pageIdStr = normalizePageId(pageId);

          log("info", "Incoming message", { ...metaBase, textPreview: userMessage.slice(0, 120) });

          const getFreshConvo = async () =>
            db.collection("Conversations").findOne({
              pageId: pageIdStr,
              userId: sender_psid,
              source: "messenger",
            });

          let convoCheck = await getFreshConvo();

          if (
            convoCheck?.humanEscalation === true &&
            convoCheck?.botResumeAt &&
            new Date() >= new Date(convoCheck.botResumeAt)
          ) {
            await db.collection("Conversations").updateOne(
              { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
              {
                $set: {
                  humanEscalation: false,
                  botResumeAt: null,
                  autoResumedAt: new Date(),
                },
              }
            );

            log("info", "Bot auto-resumed (timer)", metaBase);
            convoCheck = await getFreshConvo();
          }

          if (convoCheck?.humanEscalation === true) {
            log("info", "Human escalation active; bot ignoring message", metaBase);
            continue;
          }

        
console.log("🔵 About to enqueue message for", sender_psid);
await enqueueMessengerMessage({ pageId, sender_psid, userMessage, eventKey });
console.log("🟢 Enqueue successful for", sender_psid);
      
        }

        if (webhook_event.postback?.payload) {
          const payload = webhook_event.postback.payload;

          const responses = {
            ICE_BREAKER_PROPERTIES: "Sure! What type of property are you looking for and in which area?",
            ICE_BREAKER_BOOK: "You can book a visit by telling me the property you're interested in.",
            ICE_BREAKER_PAYMENT: "Yes! We offer several payment plans. What’s your budget or preferred duration?",
          };

          if (responses[payload]) {
            await sendMarkAsRead(sender_psid, pageId);
            await sendMessengerReply(sender_psid, responses[payload], pageId);
          }
        }
      } catch (error) {
        log("error", "Messenger handler error", { ...metaBase, err: error.message });
        await logToDb("error", "messenger", "Messenger handler error", { ...metaBase, err: error.message });

        try {
          await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", pageId);
        } catch {}
      }
    }
  }
});

export default router;