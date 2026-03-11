// instagram.js (FULL — Messenger parity + memory + WhatsApp order + human escalation)
// ✅ No auto-create clients from webhook
// ✅ Idempotency store (ProcessedEventsIG) unique(igBusinessId + eventKey) + TTL
// ✅ ECHO EVENTS: DO NOT AI-REPLY
// ✅ STAFF !bot FROM PAGE/ECHO: resumes bot for that customer
// ✅ Other echo events are ignored for history (to avoid duplicate assistant messages)
// ✅ Only AI-process inbound USER TEXT DMs
// ✅ Retrieval + runtime injection (same style as messenger.js)
// ✅ Memory: inject last N conversation turns into OpenAI
// ✅ Flags: [Human_request], [ORDER_REQUEST], [TOUR_REQUEST]
// ✅ Human escalation: pause bot; customer cannot resume with !bot
// ✅ Order -> WhatsApp notify (NO ObjectId cast issues) + Order.create
// ✅ Tour -> email
// ✅ Reply via correct endpoint: POST /{PAGE_ID}/messages?access_token=...

import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";
import jwt from "jsonwebtoken";
import { notifyClientStaffHumanNeeded } from "./utils/notifyClientStaffHumanNeeded.js";
import { retrieveChunks } from "./services/retrieval.js";
import { buildChatMessages } from "./services/promptBuilder.js";

import { getChatCompletion } from "./services/openai.js";
import { buildRulesPrompt } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import {notifyClientStaffNewOrderByClientId} from "./utils/notifyClientStaffWhatsApp.js";
import Order from "./order.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";

// IMPORTANT: Use WhatsApp service directly so we can lookup by clientId STRING
// (avoids: Cast to ObjectId failed for "realestate")
import { sendWhatsAppTemplate } from "./services/Whatsapp.js";

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

function waSafeParam(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{5,}/g, "    ")
    .trim()
    .slice(0, 1024);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isBotResumeCommand(text) {
  return String(text || "").trim().toLowerCase() === "!bot";
}

// ===============================
// DB + indexes
// ===============================
async function ensureIndexes(db) {
  try {
    const col = db.collection("ProcessedEventsIG");
    await col.createIndex({ igBusinessId: 1, eventKey: 1 }, { unique: true });
    await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // 24h

    // Helpful indexes
    await db.collection("Conversations").createIndex({ igBusinessId: 1, userId: 1, source: 1 });
    await db.collection("Customers").createIndex({ igBusinessId: 1, userId: 1, source: 1 });
    await db.collection("Clients").createIndex({ igBusinessId: 1 });
    await db.collection("Clients").createIndex({ igId: 1 });
    await db.collection("Clients").createIndex({ clientId: 1 }, { unique: false });
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
// JWT auth for review endpoints (cookie token)
// ===============================
function getCookie(req, name) {
  const raw = req.headers?.cookie || "";
  const parts = raw.split(";").map((p) => p.trim());
  const match = parts.find((p) => p.startsWith(`${name}=`));
  if (!match) return "";
  return decodeURIComponent(match.slice(name.length + 1));
}

function requireDashboardAuth(req, res, next) {
  try {
    const token = getCookie(req, "token");
    if (!token) return res.status(401).json({ ok: false, error: "Unauthorized (no cookie token)" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, clientId }
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized (invalid token)" });
  }
}

function requireOwnerOrAdmin(req, res, next) {
  const role = req.user?.role;
  if (role === "admin") return next();

  const requestedClientId = normalizeId(req.query.clientId || req.body?.clientId);
  if (!requestedClientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

  if (role === "client" && normalizeId(req.user?.clientId) !== requestedClientId) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  return next();
}

// ===============================
// Idempotency (Meta retries webhooks)
// ===============================
function buildIgEventKey(ev) {
  const mid = ev?.message?.mid;
  if (mid) return `mid:${normalizeId(mid)}`;

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
async function getClientByIgBusinessId(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igStr = normalizeId(igBusinessId);

  const client =
    (await clients.findOne({ igBusinessId: igStr })) ||
    (await clients.findOne({ igId: igStr })); // legacy

  if (!client) return null;

  const clientId = normalizeId(client.clientId);

  const pageId = normalizeId(client.pageId || client.PAGE_ID || client.page_id);
  const pageAccessToken = sanitizeAccessToken(
    client.pageAccessToken ||
      client.PAGE_ACCESS_TOKEN ||
      client.PAGE_ACCESS_TOKEN_IG ||
      client.page_token ||
      client.pageToken ||
      client.PAGE_TOKEN ||
      client.igAccessToken ||
      ""
  );

  return { ...client, clientId, resolvedPageId: pageId, resolvedPageAccessToken: pageAccessToken };
}

async function getClientByClientId(clientId) {
  const db = await connectDB();
  const cid = normalizeId(clientId);
  if (!cid) return null;
  const client = await db.collection("Clients").findOne({ clientId: cid });
  if (!client) return null;

  const pageId = normalizeId(client.pageId || client.PAGE_ID || client.page_id);
  const pageAccessToken = sanitizeAccessToken(
    client.pageAccessToken ||
      client.PAGE_ACCESS_TOKEN ||
      client.PAGE_ACCESS_TOKEN_IG ||
      client.page_token ||
      client.pageToken ||
      client.PAGE_TOKEN ||
      client.igAccessToken ||
      ""
  );

  const igId = normalizeId(client.igBusinessId || client.igId);

  return {
    ...client,
    clientId: cid,
    resolvedPageId: pageId,
    resolvedPageAccessToken: pageAccessToken,
    resolvedIgId: igId,
  };
}

// ===============================
// Usage limits (NO upsert/create)
// ===============================
async function incrementMessageCountForIgClient(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igStr = normalizeId(igBusinessId);

  const filter = { $or: [{ igBusinessId: igStr }, { igId: igStr }] };

  const updateRes = await clients.updateOne(filter, {
    $inc: { messageCount: 1 },
    $set: { updatedAt: new Date() },
  });

  if (!updateRes.matchedCount) {
    log("warn", "incrementMessageCountForIgClient: client not found; skipping", { igBusinessId: igStr });
    return { allowed: false, reason: "client_not_found" };
  }

  const doc = await clients.findOne(filter);
  if (!doc) return { allowed: false, reason: "client_not_found" };

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
  const cid = normalizeId(clientId);

  if (!cid) {
    log("warn", "saveConversationIG: missing clientId; skipping", { igBusinessId: igStr, userId });
    await logToDb("warn", "instagram", "saveConversationIG: missing clientId; skipping", { igBusinessId: igStr, userId });
    return;
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

async function appendTurnIG({ igBusinessId, userId, role, content, clientId }) {
  const text = String(content || "").trim();
  if (!text) return;

  const convo = await getConversationIG(igBusinessId, userId, "instagram");
  const history = Array.isArray(convo?.history) ? convo.history : [];
  history.push({ role, content: text, createdAt: new Date() });

  await saveConversationIG(
    igBusinessId,
    userId,
    history,
    new Date(),
    normalizeId(clientId || convo?.clientId || ""),
    "instagram"
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

  return safeJsonParse(text) || { username: "there" };
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

function isInboundUserText(igBusinessId, ev) {
  const msg = ev?.message;
  if (!msg?.text) return false;
  if (msg?.is_echo) return false;

  const senderId = normalizeId(ev?.sender?.id);
  if (!senderId) return false;

  if (senderId === normalizeId(igBusinessId)) return false;
  return true;
}

function injectHistory(messages, compactHistory) {
  const arr = Array.isArray(compactHistory) ? compactHistory : [];
  if (!arr.length) return messages;

  const filtered = arr
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));

  if (!filtered.length) return messages;

  const sliceCount = Math.max(0, MEMORY_TURNS * 2);
  const tail = filtered.slice(-sliceCount);
  if (!tail.length) return messages;

  const out = messages.slice();

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
// Resume conversation from dashboard
// body: { igBusinessId, userId }
// ===============================
async function resumeConversationIGByStaff({ igBusinessId, userId, resumedBy = "dashboard" }) {
  const db = await connectDB();
  const igStr = normalizeId(igBusinessId);
  const userIdStr = normalizeId(userId);

  if (!igStr || !userIdStr) {
    throw new Error("Missing igBusinessId or userId");
  }

  const clientDoc = await getClientByIgBusinessId(igStr);
  const clientId = normalizeId(clientDoc?.clientId || "");

  await db.collection("Conversations").updateOne(
    { igBusinessId: igStr, userId: userIdStr, source: "instagram" },
    {
      $set: {
        igBusinessId: igStr,
        clientId,
        userId: userIdStr,
        source: "instagram",
        humanEscalation: false,
        botResumeAt: null,
        resumedBy,
        resumedAt: new Date(),
        updatedAt: new Date(),
        lastInteraction: new Date(),
      },
      $setOnInsert: {
        history: [],
        humanRequestCount: 0,
        tourRequestCount: 0,
        orderRequestCount: 0,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  return { ok: true, igBusinessId: igStr, userId: userIdStr };
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
// IG profile + media (for instagram_basic review)
// ===============================
async function fetchIgBusinessProfile({ igId, pageAccessToken }) {
  const token = sanitizeAccessToken(pageAccessToken);
  const id = normalizeId(igId);

  if (!id) throw new Error("Missing igId");
  if (!isLikelyValidToken(token)) throw new Error("Missing/invalid page access token");

  const url = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(id)}`);
  url.searchParams.set(
    "fields",
    ["id", "username", "name", "biography", "followers_count", "media_count", "profile_picture_url"].join(",")
  );
  url.searchParams.set("access_token", token);

  const r = await fetch(url.toString());
  const txt = await r.text().catch(() => "");
  const data = safeJsonParse(txt) || { raw: txt };

  if (!r.ok) throw new Error(`IG profile fetch failed: ${JSON.stringify(data)}`);
  return data;
}

async function fetchIgBusinessMedia({ igId, pageAccessToken, limit = 6 }) {
  const token = sanitizeAccessToken(pageAccessToken);
  const id = normalizeId(igId);

  if (!id) throw new Error("Missing igId");
  if (!isLikelyValidToken(token)) throw new Error("Missing/invalid page access token");

  const url = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(id)}/media`);
  url.searchParams.set("fields", ["id", "caption", "media_type", "media_url", "permalink", "timestamp"].join(","));
  url.searchParams.set("limit", String(Math.max(1, Math.min(25, Number(limit) || 6))));
  url.searchParams.set("access_token", token);

  const r = await fetch(url.toString());
  const txt = await r.text().catch(() => "");
  const data = safeJsonParse(txt) || { raw: txt };

  if (!r.ok) throw new Error(`IG media fetch failed: ${JSON.stringify(data)}`);
  return data?.data || [];
}

// ===============================
// WhatsApp notify (lookup by clientId STRING, no ObjectId casting)
// ===============================


// ===============================
// Order flow
// ===============================
async function createOrderFlow({
  clientId,
  igBusinessId,
  senderId,
  orderSummaryText,
  channel = "instagram",
}) {
  const db = await connectDB();
  const cid = normalizeId(clientId);

  if (!cid) {
    throw new Error("Missing clientId (string) for createOrderFlow");
  }

  const client = await db.collection("Clients").findOne({ clientId: cid });
  if (!client) {
    throw new Error(`Client not found for clientId=${cid}`);
  }

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

  const notifyResult = await notifyClientStaffNewOrderByClientId({
    clientId: cid,
    payload: {
      customerName: waSafeParam(customerName),
      customerPhone: waSafeParam(customerPhone),
      itemsText: waSafeParam(itemsText),
      notes: waSafeParam(combinedNotes),
      orderId: waSafeParam(fallbackOrderId),
      channel,
    },
  });

  log("info", "WhatsApp notify result (IG)", {
    igBusinessId,
    clientId: cid,
    notifyResult,
  });

  try {
    const order = await Order.create({
      clientId: cid,
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

    log("info", "Order saved (IG)", {
      igBusinessId,
      clientId: cid,
      orderId: String(order._id),
    });

    return { order, notifyResult };
  } catch (e) {
    log("warn", "Order save failed (IG) (WhatsApp already sent)", {
      igBusinessId,
      clientId: cid,
      err: e.message,
    });

    await logToDb("warn", "order", "Order save failed (IG) (WhatsApp already sent)", {
      igBusinessId,
      clientId: cid,
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
// Manual per-conversation resume
// body: { igBusinessId, userId }
// ===============================
router.post("/resume-conversation", express.json(), async (req, res) => {
  try {
    const igBusinessId = normalizeId(req.body?.igBusinessId);
    const userId = normalizeId(req.body?.userId);

    if (!igBusinessId || !userId) {
      return res.status(400).json({ ok: false, error: "Missing igBusinessId or userId" });
    }

    const result = await resumeConversationIGByStaff({
      igBusinessId,
      userId,
      resumedBy: "dashboard",
    });

    log("info", "Instagram conversation resumed manually", result);
    return res.json(result);
  } catch (e) {
    log("error", "IG resume-conversation failed", { err: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===============================
// REVIEW ENDPOINTS
// ===============================
router.get("/review/profile", requireDashboardAuth, requireOwnerOrAdmin, async (req, res) => {
  try {
    const clientId = normalizeId(req.query.clientId);
    const client = await getClientByClientId(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const igId = normalizeId(client.resolvedIgId);
    if (!igId) return res.status(400).json({ ok: false, error: "Client has no igId/igBusinessId saved" });

    const pageToken = client.resolvedPageAccessToken;
    if (!isLikelyValidToken(pageToken)) {
      return res.status(400).json({ ok: false, error: "Missing/invalid PAGE_ACCESS_TOKEN for IG profile/media" });
    }

    const data = await fetchIgBusinessProfile({ igId, pageAccessToken: pageToken });

    try {
      const db = await connectDB();
      await db.collection("Clients").updateOne(
        { clientId },
        {
          $set: {
            igId: data.id || client.igId || "",
            igBusinessId: data.id || client.igBusinessId || client.igId || "",
            igUsername: data.username || "",
            igName: data.name || "",
            igProfilePicUrl: data.profile_picture_url || "",
            igIdentityUpdatedAt: new Date(),
          },
        }
      );
    } catch {}

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

router.get("/review/media", requireDashboardAuth, requireOwnerOrAdmin, async (req, res) => {
  try {
    const clientId = normalizeId(req.query.clientId);
    const client = await getClientByClientId(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const igId = normalizeId(client.resolvedIgId);
    if (!igId) return res.status(400).json({ ok: false, error: "Client has no igId/igBusinessId saved" });

    const pageToken = client.resolvedPageAccessToken;
    if (!isLikelyValidToken(pageToken)) {
      return res.status(400).json({ ok: false, error: "Missing/invalid PAGE_ACCESS_TOKEN for IG profile/media" });
    }

    const limit = Number(req.query.limit || 6);
    const data = await fetchIgBusinessMedia({ igId, pageAccessToken: pageToken, limit });

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/review/send-dm", requireDashboardAuth, requireOwnerOrAdmin, express.json(), async (req, res) => {
  try {
    const clientId = normalizeId(req.body?.clientId);
    const text = String(req.body?.text || "").trim().slice(0, 1000);
    let recipientId = normalizeId(req.body?.recipientId || "");

    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    const client = await getClientByClientId(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const pageId = client.resolvedPageId;
    const pageToken = client.resolvedPageAccessToken;

    if (!pageId) return res.status(400).json({ ok: false, error: "Client missing pageId" });
    if (!isLikelyValidToken(pageToken)) {
      return res.status(400).json({ ok: false, error: "Missing/invalid PAGE_ACCESS_TOKEN" });
    }

    if (!recipientId) {
      recipientId = normalizeId(client.lastIgSenderId || "");
    }
    if (!recipientId) {
      return res.status(400).json({
        ok: false,
        error: "Missing recipientId and no lastIgSenderId stored yet. DM the IG account first to capture senderId.",
      });
    }

    const out = await sendInstagramDM({
      pageId,
      pageAccessToken: pageToken,
      recipientId,
      text,
    });

    await appendTurnIG({
      igBusinessId: client.resolvedIgId || client.igBusinessId || client.igId || "",
      userId: recipientId,
      role: "assistant",
      content: text,
      clientId,
    });

    return res.json({ ok: true, out, usedRecipientId: recipientId });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

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

  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry || []) {
    const igBusinessId = normalizeId(entry.id);
    const events = entry.messaging || [];

    for (const webhook_event of events) {
      const senderId = normalizeId(webhook_event?.sender?.id);
      const recipientId = normalizeId(webhook_event?.recipient?.id);
      const isEcho = Boolean(webhook_event?.message?.is_echo);
      const msgText = String(webhook_event?.message?.text || "").trim();

      const metaBase = {
        igBusinessId,
        senderId,
        recipientId,
        isEcho,
        hasMessage: Boolean(webhook_event?.message),
      };

      const eventKey = buildIgEventKey(webhook_event);
      if (eventKey && (await wasProcessedIg(igBusinessId, eventKey))) {
        log("info", "Skipping duplicate IG webhook event", { ...metaBase, eventKey });
        continue;
      }
      await markProcessedIg(igBusinessId, eventKey, metaBase);

      let clientDoc = null;
      try {
        clientDoc = await getClientByIgBusinessId(igBusinessId);
      } catch {}
      if (!clientDoc) {
        log("warn", "IG webhook for unknown igBusinessId; ignoring", { igBusinessId });
        await logToDb("warn", "instagram", "IG webhook for unknown igBusinessId; ignoring", { igBusinessId });
        continue;
      }
      if (clientDoc.active === false) continue;

      const clientId = normalizeId(clientDoc.clientId);
      if (!clientId) {
        log("error", "Client missing clientId string (required). Fix Clients document.", {
          igBusinessId,
          clientMongoId: String(clientDoc._id),
        });
        await logToDb("error", "instagram", "Client missing clientId string (required).", {
          igBusinessId,
          clientMongoId: String(clientDoc._id),
        });
        continue;
      }

      try {
        const db = await connectDB();

        // ✅ Echo handling
        // Only handle staff !bot resume.
        // Do NOT store normal echo text because assistant replies are already saved
        // in the main flow / review flow, and storing echo duplicates them.
        if (isEcho) {
          const customerId = normalizeId(recipientId);

          if (isBotResumeCommand(msgText)) {
            if (!customerId) {
              log("warn", "IG echo !bot received but target customer missing", {
                igBusinessId,
                eventKey,
              });
              await logToDb("warn", "instagram", "IG echo !bot received but target customer missing", {
                igBusinessId,
                eventKey,
              });
              continue;
            }

            await db.collection("Conversations").updateOne(
              { igBusinessId: normalizeId(igBusinessId), userId: customerId, source: "instagram" },
              {
                $set: {
                  igBusinessId: normalizeId(igBusinessId),
                  clientId,
                  userId: customerId,
                  source: "instagram",
                  humanEscalation: false,
                  botResumeAt: null,
                  resumedBy: "staff",
                  resumedAt: new Date(),
                  updatedAt: new Date(),
                  lastInteraction: new Date(),
                },
                $setOnInsert: {
                  history: [],
                  humanRequestCount: 0,
                  tourRequestCount: 0,
                  orderRequestCount: 0,
                  createdAt: new Date(),
                },
              },
              { upsert: true }
            );

            log("info", "IG bot resumed by staff", { igBusinessId, customerId });

            try {
              const pageId = clientDoc.resolvedPageId;
              const pageToken = clientDoc.resolvedPageAccessToken;

              const resumeMsg =
                "✅ The assistant is back. You can continue chatting now.\n\nتمت إعادة تفعيل المساعد.";

              await sendInstagramDM({
                pageId,
                pageAccessToken: pageToken,
                recipientId: customerId,
                text: resumeMsg,
              });

              await appendTurnIG({
                igBusinessId,
                userId: customerId,
                role: "assistant",
                content: resumeMsg,
                clientId,
              });
            } catch (e) {
              log("warn", "Failed sending IG resume confirmation after staff !bot", {
                igBusinessId,
                customerId,
                err: e.message,
              });
            }

            continue;
          }

          log("info", "IG echo event ignored (already saved elsewhere)", { igBusinessId, eventKey });
          continue;
        }

        if (!isInboundUserText(igBusinessId, webhook_event)) {
          log("info", "Non-inbound/non-text IG event ignored", { igBusinessId, eventKey, senderId, recipientId });
          continue;
        }

        const userText = msgText;

        try {
          await db.collection("Clients").updateOne(
            { _id: clientDoc._id },
            {
              $set: {
                lastWebhookAt: new Date(),
                updatedAt: new Date(),
                lastIgSenderId: senderId,
                lastIgSenderText: String(userText || "").slice(0, 500),
                lastIgSenderAt: new Date(),
              },
            }
          );
        } catch {}

        const pageId = clientDoc.resolvedPageId;
        const pageToken = clientDoc.resolvedPageAccessToken;

        if (!pageId || !isLikelyValidToken(pageToken)) {
          log("warn", "Client missing pageId or PAGE_ACCESS_TOKEN for IG send", {
            igBusinessId,
            pageId: pageId || null,
          });
          await logToDb("warn", "instagram", "Client missing pageId or PAGE_ACCESS_TOKEN for IG send", {
            igBusinessId,
            pageId: pageId || null,
          });
          continue;
        }

        const getFreshConvo = async () =>
          db.collection("Conversations").findOne({
            igBusinessId: normalizeId(igBusinessId),
            userId: senderId,
            source: "instagram",
          });

        let convoCheck = await getFreshConvo();

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

        if (isBotResumeCommand(userText)) {
          log("info", "Customer sent !bot on IG but only staff can resume bot", metaBase);
          continue;
        }

        if (convoCheck?.humanEscalation === true) {
          await appendTurnIG({
            igBusinessId,
            userId: senderId,
            role: "user",
            content: userText,
            clientId,
          });

          log("info", "IG human escalation active; bot ignoring message (recorded inbound)", metaBase);
          continue;
        }

        const rulesPrompt = buildRulesPrompt(clientDoc);

        const botType = clientDoc?.knowledgeBotType || "default";
        const sectionsOrder = clientDoc?.sectionsOrder || ["menu", "offers", "hours"];

        const convo = await getConversationIG(igBusinessId, senderId, "instagram");
        const compactHistory = Array.isArray(convo?.history) ? convo.history : [];

        let greeting = "";
        if (!convo || isNewDay(convo.lastInteraction)) {
          const userProfile = await getUserProfileIG(senderId, pageToken, metaBase);
          await saveCustomerIG(igBusinessId, senderId, userProfile);
          const username = userProfile.username || "there";
          greeting = `Hi ${username}, good to see you today 👋`;
        }

        const usage = await incrementMessageCountForIgClient(igBusinessId);
        if (!usage.allowed) {
          if (usage.reason === "client_not_found") continue;

          const limitMsg = "⚠️ Message limit reached.";

          await sendInstagramDM({
            pageId,
            pageAccessToken: pageToken,
            recipientId: senderId,
            text: limitMsg,
          });

          await appendTurnIG({
            igBusinessId,
            userId: senderId,
            role: "assistant",
            content: limitMsg,
            clientId,
          });

          continue;
        }

        let grouped = {};
        try {
          grouped = await retrieveChunks({ db, clientId, botType, userText });
        } catch (e) {
          grouped = {};
          log("warn", "IG retrieveChunks failed", { ...metaBase, err: e.message });
          await logToDb("warn", "retrieval", "IG retrieveChunks failed", { ...metaBase, err: e.message });
        }

        const { messages: baseMessages, meta } = buildChatMessages({
          rulesPrompt,
          groupedChunks: grouped,
          userText,
          sectionsOrder,
        });

        if (meta?.code) {
          log("warn", "IG prompt builder warning", { ...metaBase, meta });
        }

        const messagesForOpenAI = injectHistory(baseMessages, compactHistory);

        let assistantMessage = "";
        try {
          assistantMessage = await getChatCompletion(messagesForOpenAI);
        } catch (err) {
          log("error", "IG OpenAI error", { ...metaBase, err: err.message });
          await logToDb("error", "openai", err.message, metaBase);
          assistantMessage = "⚠️ I'm having trouble right now. Please try again shortly.";
        }

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

        compactHistory.push({ role: "user", content: userText, createdAt: new Date() });

        if (flags.human) {
          const botResumeAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

          await db.collection("Conversations").updateOne(
            { igBusinessId: normalizeId(igBusinessId), userId: senderId, source: "instagram" },
            {
              $set: {
                humanEscalation: true,
                botResumeAt,
                humanEscalationStartedAt: new Date(),
                updatedAt: new Date(),
              },
              $inc: { humanRequestCount: 1 },
            },
            { upsert: true }
          );

          log("warn", "Instagram human escalation triggered", {
            igBusinessId: normalizeId(igBusinessId),
            userId: senderId,
            pageId,
            clientId,
          });

          try {
            const notifyResult = await notifyClientStaffHumanNeeded({
              clientId,
              pageId,
              userId: senderId,
              source: "instagram",
            });

            log("info", "Instagram human escalation staff notify result", {
              igBusinessId: normalizeId(igBusinessId),
              userId: senderId,
              pageId,
              clientId,
              notifyResult,
            });

            await logToDb("info", "instagram", "Instagram human escalation staff notify result", {
              igBusinessId: normalizeId(igBusinessId),
              userId: senderId,
              pageId,
              clientId,
              notifyResult,
            });
          } catch (err) {
            log("warn", "Instagram human escalation notify failed", {
              igBusinessId: normalizeId(igBusinessId),
              userId: senderId,
              pageId,
              clientId,
              err: err.message,
            });

            await logToDb("warn", "instagram", "Instagram human escalation notify failed", {
              igBusinessId: normalizeId(igBusinessId),
              userId: senderId,
              pageId,
              clientId,
              err: err.message,
            });
          }

          const msg =
            "👤 A human agent will take over shortly.\nThe assistant will return when staff reactivate it from the dashboard.\n\nسيقوم أحد موظفي الدعم بالرد عليك قريبًا وسيعود المساعد عند إعادة تفعيله من لوحة التحكم.";

          await sendInstagramDM({
            pageId,
            pageAccessToken: pageToken,
            recipientId: senderId,
            text: msg,
          });

          compactHistory.push({ role: "assistant", content: msg, createdAt: new Date() });
          await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");

          continue;
        }

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

            const msg =
              "✅ Your order request has been received.\nA staff member will contact you shortly.\n\nتم استلام طلبك وسيتم التواصل معك قريبًا.";

            await sendInstagramDM({
              pageId,
              pageAccessToken: pageToken,
              recipientId: senderId,
              text: msg,
            });

            compactHistory.push({ role: "assistant", content: msg, createdAt: new Date() });
            await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");

            continue;
          } catch (err) {
            log("error", "IG Order flow failed", { ...metaBase, err: err.message });
            await logToDb("error", "order", "IG Order flow failed", { ...metaBase, err: err.message });

            const msg = "⚠️ We couldn't process your order right now. Please try again.";

            await sendInstagramDM({
              pageId,
              pageAccessToken: pageToken,
              recipientId: senderId,
              text: msg,
            });

            compactHistory.push({ role: "assistant", content: msg, createdAt: new Date() });
            await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");

            continue;
          }
        }

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

        const combinedMessage = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;

        compactHistory.push({ role: "assistant", content: combinedMessage, createdAt: new Date() });
        await saveConversationIG(igBusinessId, senderId, compactHistory, new Date(), clientId, "instagram");

        await sendInstagramDM({
          pageId,
          pageAccessToken: pageToken,
          recipientId: senderId,
          text: combinedMessage,
        });
      } catch (error) {
        log("error", "IG handler error", { ...metaBase, err: error.message });
        await logToDb("error", "instagram", "IG handler error", { ...metaBase, err: error.message });

        try {
          const pageId = clientDoc?.resolvedPageId;
          const pageToken = clientDoc?.resolvedPageAccessToken;
          if (pageId && isLikelyValidToken(pageToken)) {
            const msg = "⚠️ حصلت مشكلة. جرب تاني بعد شوية.";

            await sendInstagramDM({
              pageId,
              pageAccessToken: pageToken,
              recipientId: senderId,
              text: msg,
            });

            await appendTurnIG({
              igBusinessId,
              userId: senderId,
              role: "assistant",
              content: msg,
              clientId: clientDoc?.clientId,
            });
          }
        } catch {}
      }
    }
  }
});

export default router;