// instagram.js (Messenger + memory parity)
// ✅ No auto-create clients from webhook
// ✅ Idempotency store (ProcessedEventsIG) unique(igBusinessId + eventKey) + TTL
// ✅ Skip echo events
// ✅ Only process inbound USER TEXT DMs
// ✅ Retrieval + runtime injection (same style as messenger.js)
// ✅ Inject last N conversation turns into OpenAI (memory)
// ✅ Flags: [Human_request], [ORDER_REQUEST], [TOUR_REQUEST]
// ✅ Human escalation: pause bot + allow "!bot" resume
// ✅ Order -> WhatsApp notify + Order.create (same utils as messenger.js)
// ✅ Tour -> email
// ✅ Reply via correct endpoint: POST /{PAGE_ID}/messages?access_token=...

import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";
import crypto from "crypto";

import { retrieveChunks } from "./services/retrieval.js";
import { buildChatMessages } from "./services/promptBuilder.js";

import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";

import Order from "./order.js";
import { notifyClientStaffNewOrder } from "./utils/notifyClientStaffWhatsApp.js";

import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

let mongoConnected = false;

// how many past turns to send to OpenAI for memory (user+assistant pairs)
const MEMORY_TURNS = Number(process.env.IG_MEMORY_TURNS || 6); // 6 pairs => up to 12 messages

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
function normalizeId(id) {
  return String(id || "").trim();
}

function sanitizeAccessToken(token) {
  return String(token || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^"|"$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function isLikelyValidToken(token) {
  const t = sanitizeAccessToken(token);
  return t.length >= 60 && /^EAA/i.test(t);
}

// ===============================
// DB + indexes
// ===============================
async function ensureIndexes(db) {
  try {
    const col = db.collection("ProcessedEventsIG");
    await col.createIndex({ igBusinessId: 1, eventKey: 1 }, { unique: true });
    await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // 24h
  } catch (e) {
    console.warn("⚠️ ensureIndexes(IG) failed:", e.message);
  }
}

async function connectDB() {
  if (!mongoConnected) {
    log("info", "Connecting to MongoDB...");
    await mongoClient.connect();
    mongoConnected = true;
    log("info", "MongoDB connected");
    try {
      await ensureIndexes(mongoClient.db(dbName));
    } catch {}
  }
  return mongoClient.db(dbName);
}

// ===============================
// Idempotency (Meta retries webhooks)
// ===============================
function buildIgEventKey(ev) {
  const mid = ev?.message?.mid;
  if (mid) return `mid:${normalizeId(mid)}`;

  // fallback
  const sender = normalizeId(ev?.sender?.id);
  const ts = normalizeId(ev?.timestamp);
  const text = String(ev?.message?.text || "").slice(0, 80);
  if (sender && ts) return `fallback:${sender}:${ts}:${text}`;

  return "";
}

async function wasProcessedIg(igBusinessId, eventKey) {
  if (!eventKey) return false;
  const db = await connectDB();
  const existing = await db.collection("ProcessedEventsIG").findOne({
    igBusinessId: normalizeId(igBusinessId),
    eventKey: String(eventKey),
  });
  return Boolean(existing);
}

async function markProcessedIg(igBusinessId, eventKey, meta = {}) {
  if (!eventKey) return;
  const db = await connectDB();
  try {
    await db.collection("ProcessedEventsIG").insertOne({
      igBusinessId: normalizeId(igBusinessId),
      eventKey: String(eventKey),
      createdAt: new Date(),
      meta,
    });
  } catch {
    // ignore duplicates
  }
}

// ===============================
// Clients (NO auto-create from webhook)
// ===============================
function newClientId() {
  return crypto.randomUUID();
}

async function getClientByIgBusinessId(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igStr = normalizeId(igBusinessId);

  const client =
    (await clients.findOne({ igBusinessId: igStr })) ||
    (await clients.findOne({ igId: igStr })); // legacy

  if (!client) return null;

  if (!client.clientId) {
    const cid = newClientId();
    await clients.updateOne({ _id: client._id }, { $set: { clientId: cid, updatedAt: new Date() } });
    client.clientId = cid;
    log("warn", "IG client missing clientId; backfilled", { igBusinessId: igStr, clientId: cid });
  }

  const pageId = normalizeId(client.pageId || client.PAGE_ID || client.page_id);
  const pageAccessToken = sanitizeAccessToken(
    client.pageAccessToken ||
      client.PAGE_ACCESS_TOKEN ||
      client.page_token ||
      client.pageToken ||
      client.PAGE_TOKEN ||
      ""
  );

  return { ...client, resolvedPageId: pageId, resolvedPageAccessToken: pageAccessToken };
}

// ===============================
// Usage limits (NO upsert/create)
// ===============================
async function incrementMessageCountForIgClient(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igStr = normalizeId(igBusinessId);

  const filter = { $or: [{ igBusinessId: igStr }, { igId: igStr }] };

  const updateRes = await clients.updateOne(
    filter,
    { $inc: { messageCount: 1 }, $set: { updatedAt: new Date() } }
  );

  if (!updateRes.matchedCount) {
    log("warn", "incrementMessageCountForIgClient: client not found; skipping", { igBusinessId: igStr });
    return { allowed: false, reason: "client_not_found" };
  }

  const doc = await clients.findOne(filter);
  if (!doc) return { allowed: false, reason: "client_not_found" };

  if (!doc.clientId) {
    const cid = newClientId();
    await clients.updateOne(filter, { $set: { clientId: cid, updatedAt: new Date() } });
    doc.clientId = cid;
  }

  const messageLimit = doc.messageLimit ?? 1000;
  const messageCount = doc.messageCount ?? 0;

  if (messageCount > messageLimit) {
    log("warn", "Message limit reached for igBusinessId", { igBusinessId: igStr, messageCount, messageLimit });
    return { allowed: false, messageCount, messageLimit, reason: "quota_exceeded" };
  }

  const remaining = messageLimit - messageCount;

  if (remaining === 100 && !doc.quotaWarningSent) {
    log("warn", "Only 100 messages left for igBusinessId", { igBusinessId: igStr });
    await sendQuotaWarning(igStr);
    await clients.updateOne(filter, { $set: { quotaWarningSent: true, updatedAt: new Date() } });
  }

  return { allowed: true, messageCount, messageLimit };
}

// ===============================
// Conversation + Customers
// ===============================
async function getConversationIG(igBusinessId, userId, source = "instagram") {
  const db = await connectDB();
  const igStr = normalizeId(igBusinessId);
  return db.collection("Conversations").findOne({ igBusinessId: igStr, userId, source });
}

async function saveConversationIG(igBusinessId, userId, history, lastInteraction, clientId, source = "instagram") {
  const db = await connectDB();
  const igStr = normalizeId(igBusinessId);

  // ensure client exists
  const client = await db.collection("Clients").findOne({ $or: [{ igBusinessId: igStr }, { igId: igStr }] });
  if (!client) {
    log("warn", "saveConversationIG: client not found; skipping", { igBusinessId: igStr });
    await logToDb("warn", source, "saveConversationIG: client not found; skipping", { igBusinessId: igStr });
    return;
  }

  let cid = clientId || client.clientId;
  if (!cid) {
    cid = newClientId();
    await db.collection("Clients").updateOne({ _id: client._id }, { $set: { clientId: cid, updatedAt: new Date() } });
  }

  await db.collection("Conversations").updateOne(
    { igBusinessId: igStr, userId, source },
    {
      $set: {
        igBusinessId: igStr,
        clientId: cid,
        userId,
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

async function saveCustomerIG(igBusinessId, userId, userProfile) {
  const db = await connectDB();
  const igStr = normalizeId(igBusinessId);

  const username = (userProfile?.username || "").trim();

  await db.collection("Customers").updateOne(
    { igBusinessId: igStr, userId, source: "instagram" },
    {
      $set: {
        igBusinessId: igStr,
        userId,
        source: "instagram",
        name: username || "Unknown",
        lastInteraction: new Date(),
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function getUserProfileIG(userId, pageAccessToken, meta = {}) {
  const token = sanitizeAccessToken(pageAccessToken);
  if (!isLikelyValidToken(token)) return { username: "there" };

  const url = new URL(`https://graph.facebook.com/v20.0/${normalizeId(userId)}`);
  url.searchParams.set("fields", "username");
  url.searchParams.set("access_token", token);

  let res;
  try {
    res = await fetch(url.toString());
  } catch (e) {
    log("warn", "IG Graph profile fetch failed (network)", { ...meta, err: e.message });
    return { username: "there" };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    log("warn", "IG Graph profile fetch failed", { ...meta, status: res.status, response: text.slice(0, 500) });
    return { username: "there" };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { username: "there" };
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

// inbound USER text only
function isInboundUserText(igBusinessId, ev) {
  const msg = ev?.message;
  if (!msg?.text) return false;
  if (msg?.is_echo) return false;

  const senderId = normalizeId(ev?.sender?.id);
  if (!senderId) return false;

  // sender must NOT be the igBusinessId itself
  if (senderId === normalizeId(igBusinessId)) return false;

  return true;
}

// inject last N turns into OpenAI messages
function injectHistory(messages, compactHistory) {
  const arr = Array.isArray(compactHistory) ? compactHistory : [];
  if (!arr.length) return messages;

  // keep only user/assistant
  const filtered = arr
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));

  if (!filtered.length) return messages;

  // take last MEMORY_TURNS pairs (approx). We just slice last 2*MEMORY_TURNS messages.
  const sliceCount = Math.max(0, MEMORY_TURNS * 2);
  const tail = filtered.slice(-sliceCount);

  // Insert history AFTER system/rules messages (keep system first)
  // Assume buildChatMessages returns something starting with system messages; we’ll append tail before the final user message.
  // If structure differs, this is still safe.
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    out.push(messages[i]);
  }

  // If the last message is the current user message, better to insert history before it.
  if (out.length && out[out.length - 1]?.role === "user") {
    const last = out.pop();
    out.push(...tail);
    out.push(last);
    return out;
  }

  out.push(...tail);
  return out;
}

// ===============================
// IG send: POST /{PAGE_ID}/messages
// ===============================
async function sendInstagramDM({ pageId, pageAccessToken, recipientId, text }) {
  const token = sanitizeAccessToken(pageAccessToken);
  const pid = normalizeId(pageId);
  const rid = normalizeId(recipientId);

  if (!pid) throw new Error("Missing pageId for IG send");
  if (!isLikelyValidToken(token)) throw new Error("Missing/invalid pageAccessToken for IG send");
  if (!rid) throw new Error("Missing recipientId for IG send");
  if (!text) return;

  const url = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(pid)}/messages`);
  url.searchParams.set("access_token", token);

  const payload = { recipient: { id: rid }, message: { text } };

  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Failed to send IG message: ${JSON.stringify(data)}`);
  return data;
}

// ===============================
// Order flow (WhatsApp notify + Order.create)
// ===============================
async function createOrderFlow({ clientId, igBusinessId, senderId, orderSummaryText, channel = "instagram" }) {
  const db = await connectDB();

  const client = await db.collection("Clients").findOne({ clientId: normalizeId(clientId) });
  if (!client) throw new Error(`Client not found for clientId=${clientId}`);

  const customer = await db.collection("Customers").findOne({
    igBusinessId: normalizeId(igBusinessId),
    userId: normalizeId(senderId),
    source: "instagram",
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

  const notifyResult = await notifyClientStaffNewOrder({
    clientId: client.clientId,
    payload: {
      customerName: waSafeParam(customerName),
      customerPhone: waSafeParam(customerPhone),
      itemsText: waSafeParam(itemsText),
      notes: waSafeParam(combinedNotes),
      orderId: waSafeParam(fallbackOrderId),
      channel: "instagram",
    },
  });

  log("info", "WhatsApp notify result (IG)", { igBusinessId, notifyResult });

  try {
    const order = await Order.create({
      clientId: client.clientId,
      channel,
      customer: {
        name: customerName,
        phone: customerPhone === "N/A" ? "" : customerPhone,
        externalUserId: senderId,
      },
      itemsText: orderSummaryText,
      notes: combinedNotes,
      status: "new",
    });

    log("info", "Order saved (IG)", { igBusinessId, orderId: String(order._id) });
    return { order, notifyResult };
  } catch (e) {
    log("warn", "Order save failed (IG) (WhatsApp already sent)", { igBusinessId, err: e.message });
    await logToDb("warn", "order", "Order save failed (IG) (WhatsApp already sent)", { igBusinessId, err: e.message });
    return { order: null, notifyResult };
  }
}

// ===============================
// Webhook verification (DB VERIFY_TOKEN)
// ===============================
router.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = normalizeId(req.query["hub.verify_token"]);
  const challenge = req.query["hub.challenge"];

  if (!mode || !token) return res.sendStatus(403);

  const db = await connectDB();
  const client = await db.collection("Clients").findOne({ VERIFY_TOKEN: token });

  if (mode === "subscribe" && client) {
    log("info", "IG Webhook verified", {
      igBusinessId: client.igBusinessId || client.igId,
      clientId: client.clientId,
    });
    return res.status(200).send(challenge);
  }

  log("warn", "IG Webhook verification failed", { mode, tokenProvided: true });
  return res.sendStatus(403);
});

// ===============================
// Hard-coded IG send test
// /instagram/ig-test-send?pageId=...&pageToken=...&recipientId=...&text=...
// ===============================
router.get("/ig-test-send", async (req, res) => {
  const pageId = normalizeId(req.query.pageId || process.env.PAGE_ID);
  const pageToken = sanitizeAccessToken(req.query.pageToken || process.env.PAGE_ACCESS_TOKEN);
  const recipientId = normalizeId(req.query.recipientId);
  const text = String(req.query.text || "✅ Hard-coded IG DM test").slice(0, 1000);

  try {
    const out = await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId, text });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ===============================
// Instagram webhook receiver
// ===============================
router.post("/", async (req, res) => {
  const body = req.body;

  if (body.object !== "instagram") return res.sendStatus(404);

  // respond fast (avoid retries)
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry || []) {
    const igBusinessId = normalizeId(entry.id);
    const events = entry.messaging || [];

    for (const webhook_event of events) {
      const senderId = normalizeId(webhook_event?.sender?.id);
      const recipientId = normalizeId(webhook_event?.recipient?.id);
      const isEcho = Boolean(webhook_event?.message?.is_echo);

      const metaBase = {
        igBusinessId,
        senderId,
        recipientId,
        isEcho,
        hasMessage: Boolean(webhook_event?.message),
      };

      // Idempotency (like messenger.js)
      const eventKey = buildIgEventKey(webhook_event);
      if (eventKey && (await wasProcessedIg(igBusinessId, eventKey))) {
        log("info", "Skipping duplicate IG webhook event", { ...metaBase, eventKey });
        continue;
      }
      await markProcessedIg(igBusinessId, eventKey, metaBase);

      // Only inbound user text
      if (!isInboundUserText(igBusinessId, webhook_event)) {
        if (isEcho) log("info", "Echo event, ignored", { igBusinessId, eventKey });
        continue;
      }

      const userText = webhook_event.message.text;

      try {
        const clientDoc = await getClientByIgBusinessId(igBusinessId);
        if (!clientDoc) {
          log("warn", "IG webhook for unknown igBusinessId; ignoring", { igBusinessId });
          await logToDb("warn", "instagram", "IG webhook for unknown igBusinessId; ignoring", { igBusinessId });
          continue;
        }
        if (clientDoc.active === false) continue;

        // webhook freshness
        try {
          const db = await connectDB();
          await db.collection("Clients").updateOne(
            { _id: clientDoc._id },
            { $set: { lastWebhookAt: new Date(), updatedAt: new Date() } }
          );
        } catch {}

        const pageId = clientDoc.resolvedPageId;
        const pageToken = clientDoc.resolvedPageAccessToken;

        if (!pageId || !isLikelyValidToken(pageToken)) {
          log("warn", "Client missing pageId or PAGE_ACCESS_TOKEN for IG send", { igBusinessId, pageId: pageId || null });
          await logToDb("warn", "instagram", "Client missing pageId or PAGE_ACCESS_TOKEN for IG send", { igBusinessId, pageId: pageId || null });
          continue;
        }

        const db = await connectDB();

        // ===== Conversation checks (human escalation like messenger.js)
        const getFreshConvo = async () =>
          db.collection("Conversations").findOne({
            igBusinessId: normalizeId(igBusinessId),
            userId: senderId,
            source: "instagram",
          });

        let convoCheck = await getFreshConvo();

        // Auto-resume bot if timer expired
        if (
          convoCheck?.humanEscalation === true &&
          convoCheck?.botResumeAt &&
          new Date() >= new Date(convoCheck.botResumeAt)
        ) {
          await db.collection("Conversations").updateOne(
            { igBusinessId: normalizeId(igBusinessId), userId: senderId, source: "instagram" },
            { $set: { humanEscalation: false, botResumeAt: null, autoResumedAt: new Date() } }
          );
          log("info", "IG bot auto-resumed (timer)", metaBase);
          convoCheck = await getFreshConvo();
        }

        // Resume bot command
        if (userText.trim().toLowerCase() === "!bot") {
          await db.collection("Conversations").updateOne(
            { igBusinessId: normalizeId(igBusinessId), userId: senderId, source: "instagram" },
            { $set: { humanEscalation: false, botResumeAt: null, resumedBy: "customer", resumedAt: new Date() } },
            { upsert: true }
          );

          await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId: senderId, text: "✅ Bot is reactivated!" });
          continue;
        }

        // If human escalation active → ignore bot
        if (convoCheck?.humanEscalation === true) {
          log("info", "IG human escalation active; bot ignoring message", metaBase);
          continue;
        }

        // ===============================
        // Main processing (retrieval + runtime injection + MEMORY)
        // ===============================
        const rulesPrompt = await SYSTEM_PROMPT({ igId: igBusinessId });

        const clientId = clientDoc.clientId;
        const botType = clientDoc?.botType || "default";
        const sectionsOrder = clientDoc?.sectionsOrder || ["menu", "offers", "hours"];

        // load conversation history from DB
        const convo = await getConversationIG(igBusinessId, senderId, "instagram");
        const compactHistory = Array.isArray(convo?.history) ? convo.history : [];

        let greeting = "";
        if (!convo || isNewDay(convo.lastInteraction)) {
          const userProfile = await getUserProfileIG(senderId, pageToken, metaBase);
          await saveCustomerIG(igBusinessId, senderId, userProfile);
          const username = userProfile.username || "there";
          greeting = `Hi ${username}, good to see you today 👋`;
        }

        // usage check
        const usage = await incrementMessageCountForIgClient(igBusinessId);
        if (!usage.allowed) {
          if (usage.reason === "client_not_found") return;
          await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId: senderId, text: "⚠️ Message limit reached." });
          return;
        }

        // retrieve relevant chunks
        let grouped = {};
        try {
          grouped = await retrieveChunks({ db, clientId, botType, userText });
        } catch (e) {
          grouped = {};
          log("warn", "IG retrieveChunks failed", { ...metaBase, err: e.message });
          await logToDb("warn", "retrieval", "IG retrieveChunks failed", { ...metaBase, err: e.message });
        }

        // build base messages
        const { messages: baseMessages } = buildChatMessages({
          rulesPrompt,
          groupedChunks: grouped,
          userText,
          sectionsOrder,
        });

        // ✅ Inject memory (last N turns) into OpenAI
        const messagesForOpenAI = injectHistory(baseMessages, compactHistory);

        let assistantMessage = "";
        try {
          assistantMessage = await getChatCompletion(messagesForOpenAI);
        } catch (err) {
          log("error", "IG OpenAI error", { ...metaBase, err: err.message });
          await logToDb("error", "openai", err.message, metaBase);
          assistantMessage = "⚠️ I'm having trouble right now. Please try again shortly.";
        }

        // Flags (same as messenger.js)
        const flags = { human: false, tour: false, order: false };

        if (assistantMessage.includes("[Human_request]")) {
          flags.human = true;
          assistantMessage = assistantMessage.replace("[Human_request]", "").trim();
        }
        if (assistantMessage.includes("[ORDER_REQUEST]")) {
          flags.order = true;
          assistantMessage = assistantMessage.replace("[ORDER_REQUEST]", "").trim();
        }
        if (assistantMessage.includes("[TOUR_REQUEST]")) {
          flags.tour = true;
          assistantMessage = assistantMessage.replace("[TOUR_REQUEST]", "").trim();
        }

        // Human escalation
        if (flags.human) {
          const botResumeAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

          await db.collection("Conversations").updateOne(
            { igBusinessId: normalizeId(igBusinessId), userId: senderId, source: "instagram" },
            {
              $set: { humanEscalation: true, botResumeAt, humanEscalationStartedAt: new Date() },
              $inc: { humanRequestCount: 1 },
            },
            { upsert: true }
          );

          await sendInstagramDM({
            pageId,
            pageAccessToken: pageToken,
            recipientId: senderId,
            text:
              "👤 A human agent will take over shortly.\nYou can type !bot anytime to return to the assistant.\n\nسيقوم أحد موظفي الدعم بالرد عليك قريبًا.",
          });

          // save conversation turns
          compactHistory.push({ role: "user", content: userText, createdAt: new Date() });
          compactHistory.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
          await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");
          continue;
        }

        // Order handling -> WhatsApp notify + Order.create
        if (flags.order) {
          await db.collection("Conversations").updateOne(
            { igBusinessId: normalizeId(igBusinessId), userId: senderId, source: "instagram" },
            { $inc: { orderRequestCount: 1 } },
            { upsert: true }
          );

          try {
            await createOrderFlow({
              clientId,
              igBusinessId,
              senderId,
              orderSummaryText: assistantMessage,
              channel: "instagram",
            });

            await sendInstagramDM({
              pageId,
              pageAccessToken: pageToken,
              recipientId: senderId,
              text: "✅ Your order request has been received.\nA staff member will contact you shortly.\n\nتم استلام طلبك وسيتم التواصل معك قريبًا.",
            });

            compactHistory.push({ role: "user", content: userText, createdAt: new Date() });
            compactHistory.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
            await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");
            continue;
          } catch (err) {
            log("error", "IG Order flow failed", { ...metaBase, err: err.message });
            await logToDb("error", "order", "IG Order flow failed", { ...metaBase, err: err.message });

            await sendInstagramDM({
              pageId,
              pageAccessToken: pageToken,
              recipientId: senderId,
              text: "⚠️ We couldn't process your order right now. Please try again.",
            });

            compactHistory.push({ role: "user", content: userText, createdAt: new Date() });
            compactHistory.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
            await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");
            continue;
          }
        }

        // Tour handling -> email
        if (flags.tour) {
          await db.collection("Conversations").updateOne(
            { igBusinessId: normalizeId(igBusinessId), userId: senderId, source: "instagram" },
            { $inc: { tourRequestCount: 1 } },
            { upsert: true }
          );

          try {
            const data = extractTourData(assistantMessage);
            data.igBusinessId = igBusinessId;
            data.clientId = clientId;
            await sendTourEmail(data);
          } catch (e) {
            log("warn", "IG tour email failed", { ...metaBase, err: e.message });
            await logToDb("warn", "email", "IG tour email failed", { ...metaBase, err: e.message });
          }
        }

        // Save conversation
        compactHistory.push({ role: "user", content: userText, createdAt: new Date() });
        compactHistory.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
        await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");

        const combinedMessage = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;
        await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId: senderId, text: combinedMessage });
      } catch (error) {
        log("error", "IG handler error", { ...metaBase, err: error.message });
        await logToDb("error", "instagram", "IG handler error", { ...metaBase, err: error.message });

        // best-effort fail message
        try {
          const clientDoc = await getClientByIgBusinessId(igBusinessId);
          if (clientDoc?.resolvedPageId && isLikelyValidToken(clientDoc?.resolvedPageAccessToken)) {
            await sendInstagramDM({
              pageId: clientDoc.resolvedPageId,
              pageAccessToken: clientDoc.resolvedPageAccessToken,
              recipientId: senderId,
              text: "⚠️ حصلت مشكلة. جرب تاني بعد شوية.",
            });
          }
        } catch {}
      }
    }
  }
});

export default router;
