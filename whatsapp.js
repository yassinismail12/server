// whatsapp.js
// ✅ SCALED: AI processing offloaded to BullMQ queue via worker.js
// Source choice flow (1/2/3 menu) stays in webhook handler since it needs
// immediate sendWhatsAppText response and doesn't involve AI.
// All AI calls moved to worker.js processWhatsAppJob().

import express from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { retrieveChunks } from "./services/retrieval.js";
import { buildChatMessages } from "./services/promptBuilder.js";
import { buildRulesPrompt } from "./utils/systemPrompt.js";
import { getChatCompletion } from "./services/openai.js";
import { sendWhatsAppText } from "./services/whatsappText.js";
import { sendWhatsAppTemplate } from "./services/whatsappTemplate.js";
import { enqueueWhatsAppMessage } from "./queue.js";

const router = express.Router();

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

// ===============================
// Helpers
// ===============================
function normalizePhoneDigits(p) {
  return String(p || "").trim().replace(/[^\d]/g, "");
}

function normalizeIdString(s) {
  return String(s || "").trim();
}

function detectUserLanguage(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || "")) ? "ar" : "en";
}

function isNewDay(lastDate) {
  const today = new Date();
  const d = lastDate ? new Date(lastDate) : null;
  return !d || d.getDate() !== today.getDate() || d.getMonth() !== today.getMonth() || d.getFullYear() !== today.getFullYear();
}

function parseSourceChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["1", "sales", "sell", "buy", "rent"].includes(t)) return "sales";
  if (["2", "support", "help"].includes(t)) return "support";
  if (["3", "order", "orders", "شراء", "طلب"].includes(t)) return "order";
  return "";
}

function sourceMenuText() {
  return (
    "Hi 👋\n" +
    "Please choose what you need:\n\n" +
    "1) Sales / Properties\n" +
    "2) Support\n" +
    "3) Order\n\n" +
    "Reply with 1, 2, or 3."
  );
}

// ===============================
// Auth
// ===============================
function parseCookieHeader(cookieHeader = "") {
  const out = {};
  cookieHeader.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function requireClient(req, res, next) {
  try {
    const tokenFromParser = req.cookies?.token;
    const tokenFromHeader = parseCookieHeader(req.headers.cookie || "").token;
    const token = tokenFromParser || tokenFromHeader;

    if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      log("error", "JWT_SECRET missing");
      return res.status(500).json({ ok: false, error: "Server misconfigured" });
    }

    const payload = jwt.verify(token, secret);
    if (!payload || payload.role !== "client" || !payload.clientId) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

// ===============================
// Token selection
// ===============================
function getAccessTokenForClient(client) {
  const dbToken = String(client?.whatsappAccessToken || "").trim();
  if (dbToken) return dbToken;
  const key = String(client?.whatsappTokenKey || "").trim().toLowerCase();
  if (key && process.env[`WHATSAPP_TOKEN_${key.toUpperCase()}`]) {
    return process.env[`WHATSAPP_TOKEN_${key.toUpperCase()}`];
  }
  return process.env.WHATSAPP_TOKEN || "";
}

// ===============================
// History helpers
// ===============================
function buildRecentHistoryMessages(history = [], limit = 12) {
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
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
    return [...systemMessages, ...nonSystemMessages.slice(0, -1), ...historyMessages, last];
  }
  return [...systemMessages, ...historyMessages, ...nonSystemMessages];
}

// ===============================
// Clients
// ===============================
async function getClientByPhoneNumberId(whatsappPhoneNumberId) {
  const db = getDB();
  const pnid = normalizeIdString(whatsappPhoneNumberId);

  let client = await db.collection("Clients").findOne({ whatsappPhoneNumberId: pnid, active: { $ne: false } });
  if (!client) {
    client = await db.collection("Clients").findOne({
      whatsappPhoneNumberId: { $in: [String(pnid), String(pnid).trim()] },
      active: { $ne: false },
    });
  }
  return client;
}

async function getClientByClientId(clientId) {
  const db = getDB();
  return db.collection("Clients").findOne({ clientId: String(clientId || "").trim(), active: { $ne: false } });
}

async function touchClientWebhook(clientMongoId, payload) {
  try {
    const db = getDB();
    await db.collection("Clients").updateOne(
      { _id: clientMongoId },
      { $set: { lastWebhookAt: new Date(), lastWebhookType: "whatsapp", lastWebhookPayload: payload } }
    );
  } catch (e) {
    log("warn", "Failed to update lastWebhook fields", { err: e.message });
  }
}

// ===============================
// Conversations
// ===============================
async function getConversation(clientId, userId) {
  const db = getDB();
  return db.collection("Conversations").findOne({ clientId: String(clientId), userId, source: "whatsapp" });
}

async function upsertConversation({ clientId, userId, history, lastInteraction, lastMessage, lastMessageAt, lastDirection, awaitSource, sourceChoice, meta = {} }) {
  const db = getDB();
  await db.collection("Conversations").updateOne(
    { clientId: String(clientId), userId, source: "whatsapp" },
    {
      $set: {
        clientId: String(clientId), userId, source: "whatsapp", sourceLabel: "WhatsApp",
        history, lastInteraction,
        lastMessage: lastMessage || "",
        lastMessageAt: lastMessageAt || lastInteraction,
        lastDirection: lastDirection || "",
        awaitSource: Boolean(awaitSource),
        sourceChoice: sourceChoice || "",
        meta: { ...(meta || {}) },
        updatedAt: new Date(),
      },
      $setOnInsert: { humanEscalation: false, createdAt: new Date() },
    },
    { upsert: true }
  );
}

// ===============================
// TEST SEND (dashboard)
// ===============================
router.post("/send-test", requireClient, async (req, res) => {
  try {
    const { clientId, to, text } = req.body || {};
    const toDigits = normalizePhoneDigits(to);

    if (!clientId || !toDigits || !text) return res.status(400).json({ ok: false, error: "Missing clientId, to, or text" });
    if (String(clientId) !== String(req.user.clientId)) return res.status(403).json({ ok: false, error: "Forbidden" });

    const client = await getClientByClientId(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const phoneNumberId = String(client.whatsappPhoneNumberId || "").trim();
    if (!phoneNumberId) return res.status(400).json({ ok: false, error: "Client missing whatsappPhoneNumberId" });

    const accessToken = getAccessTokenForClient(client);
    if (!accessToken) return res.status(500).json({ ok: false, error: "Missing WhatsApp access token" });

    await sendWhatsAppText({ phoneNumberId, to: toDigits, text: String(text), accessToken });
    return res.json({ ok: true });
  } catch (e) {
    log("error", "WA send-test failed", { err: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/send-template-test", requireClient, async (req, res) => {
  try {
    const { clientId, to, templateName, languageCode, params } = req.body || {};
    const toDigits = normalizePhoneDigits(to);

    if (!clientId || !toDigits || !templateName) return res.status(400).json({ ok: false, error: "Missing clientId, to, or templateName" });
    if (String(clientId) !== String(req.user.clientId)) return res.status(403).json({ ok: false, error: "Forbidden" });

    const client = await getClientByClientId(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const phoneNumberId = String(client.whatsappPhoneNumberId || "").trim();
    if (!phoneNumberId) return res.status(400).json({ ok: false, error: "Client missing whatsappPhoneNumberId" });

    const accessToken = getAccessTokenForClient(client);
    if (!accessToken) return res.status(500).json({ ok: false, error: "Missing WhatsApp access token" });

    await sendWhatsAppTemplate({
      phoneNumberId, to: toDigits,
      templateName: String(templateName).trim(),
      languageCode: String(languageCode || "en_US").trim(),
      bodyParams: Array.isArray(params) ? params.map(String) : [],
      accessToken,
    });

    return res.json({ ok: true });
  } catch (e) {
    log("error", "WA send-template-test failed", { err: e?.data || e.message });
    return res.status(500).json({ ok: false, error: e.message, details: e?.data || null });
  }
});

// ===============================
// List templates
// ===============================
router.get("/templates", requireClient, async (req, res) => {
  try {
    const clientId = String(req.query.clientId || "").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });
    if (String(clientId) !== String(req.user.clientId)) return res.status(403).json({ ok: false, error: "Forbidden" });

    const client = await getClientByClientId(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const wabaId = String(client.whatsappWabaId || "").trim();
    if (!wabaId) return res.status(400).json({ ok: false, error: "Client missing whatsappWabaId" });

    const accessToken = getAccessTokenForClient(client);
    if (!accessToken) return res.status(500).json({ ok: false, error: "Missing WhatsApp access token" });

    const API_VERSION = (process.env.WHATSAPP_API_VERSION || "v20.0").trim();
    const url = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,language&limit=200`;

    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const rawText = await resp.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

    if (!resp.ok) return res.status(resp.status).json({ ok: false, error: data });

    const templates = (data?.data || []).map((t) => ({ name: t.name, status: t.status, language: t.language }));
    return res.json({ ok: true, templates });
  } catch (e) {
    log("error", "WA templates fetch failed", { err: e?.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===============================
// Webhook verification
// ===============================
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    log("info", "WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  log("warn", "WhatsApp webhook verification failed", { mode, tokenProvided: Boolean(token) });
  return res.sendStatus(403);
});

// ===============================
// WhatsApp webhook receiver
// ===============================
router.post("/", async (req, res) => {
  console.log("🔥 WA POST HIT", new Date().toISOString(), "topKeys:", Object.keys(req.body || {}));

  res.sendStatus(200);

  try {
    const body = req.body;
    const entries = body?.entry || [];

    if (!Array.isArray(entries) || !entries.length) {
      log("warn", "Webhook body has no entry array", { bodyPreview: JSON.stringify(body || {}).slice(0, 300) });
      return;
    }

    for (const entry of entries) {
      const changes = entry?.changes || [];

      for (const change of changes) {
        const value = change?.value || {};
        const whatsappPhoneNumberId = value?.metadata?.phone_number_id;

        if (!whatsappPhoneNumberId) {
          log("warn", "Missing metadata.phone_number_id", { valueKeys: Object.keys(value || {}) });
          continue;
        }

        const client = await getClientByPhoneNumberId(whatsappPhoneNumberId);
        if (!client) {
          log("warn", "No client matched whatsappPhoneNumberId", { whatsappPhoneNumberId: String(whatsappPhoneNumberId) });
          continue;
        }

        const whatsappAccessToken = getAccessTokenForClient(client);
        if (!whatsappAccessToken) {
          log("warn", "Missing WhatsApp access token for client", { clientId: client.clientId });
          continue;
        }

        const staffDigits = [
          ...(Array.isArray(client.staffNumbers) ? client.staffNumbers : []),
          ...(client.staffWhatsApp ? [client.staffWhatsApp] : []),
        ].map(normalizePhoneDigits);

        const clientAwaitSource = Boolean(client.awaitSource);

        await touchClientWebhook(client._id, {
          clientId: client.clientId,
          whatsappPhoneNumberId: String(whatsappPhoneNumberId),
          hasMessages: Boolean(value?.messages?.length),
          meta: value?.metadata || null,
        });

        const messages = value?.messages || [];
        if (!messages.length) {
          log("info", "No inbound messages in webhook (likely statuses)", { clientId: client.clientId });
          continue;
        }

        for (const msg of messages) {
          const fromDigits = normalizePhoneDigits(msg?.from);
          const text = msg?.text?.body || "";

          if (!fromDigits) { log("warn", "Message missing from", { msgId: msg?.id }); continue; }
          if (!text) { log("info", "Ignoring non-text message", { clientId: client.clientId, from: fromDigits, type: msg?.type }); continue; }
          if (staffDigits.includes(fromDigits)) { log("info", "Ignoring staff message", { from: fromDigits, clientId: client.clientId }); continue; }

          const convo = await getConversation(client.clientId, fromDigits);

          if (convo?.humanEscalation === true) {
            log("info", "Human escalation active; ignoring", { from: fromDigits, clientId: client.clientId });
            continue;
          }

          const inboundAt = new Date();
          const inboundPreview = text.slice(0, 200);
          const history = Array.isArray(convo?.history) ? convo.history : [];
          const convoMeta = { whatsappPhoneNumberId: String(whatsappPhoneNumberId) };

          // ── Source choice flow (no AI — handle inline, fast) ────────────────
          const sourceChoiceExisting = convo?.sourceChoice || "";
          const needsChoice = clientAwaitSource && !sourceChoiceExisting;

          if (needsChoice) {
            const picked = parseSourceChoice(text);
            const updatedHistory = [...history, { role: "user", content: text, createdAt: inboundAt }];

            if (!picked) {
              const shouldSendMenu = !convo || isNewDay(convo.lastInteraction) || convo?.awaitSource !== true;
              await upsertConversation({
                clientId: client.clientId, userId: fromDigits, history: updatedHistory,
                lastInteraction: inboundAt, lastMessage: inboundPreview, lastMessageAt: inboundAt,
                lastDirection: "in", awaitSource: true, sourceChoice: "", meta: convoMeta,
              });
              if (shouldSendMenu) {
                await sendWhatsAppText({ phoneNumberId: String(whatsappPhoneNumberId), to: fromDigits, text: sourceMenuText(), accessToken: whatsappAccessToken });
              }
              continue;
            }

            await upsertConversation({
              clientId: client.clientId, userId: fromDigits, history: updatedHistory,
              lastInteraction: inboundAt, lastMessage: inboundPreview, lastMessageAt: inboundAt,
              lastDirection: "in", awaitSource: false, sourceChoice: picked, meta: convoMeta,
            });
            await sendWhatsAppText({
              phoneNumberId: String(whatsappPhoneNumberId), to: fromDigits,
              text: `✅ Got it. You selected: ${picked}.\nHow can I help you?`,
              accessToken: whatsappAccessToken,
            });
            continue;
          }

          // ── 🚀 QUEUE: hand off to worker for AI processing ─────────────────
          await enqueueWhatsAppMessage({
            clientId: client.clientId,
            fromDigits,
            text,
            whatsappPhoneNumberId: String(whatsappPhoneNumberId),
            msgId: msg?.id,
          });

          log("info", "WA message enqueued for processing", { clientId: client.clientId, from: fromDigits });
        }
      }
    }
  } catch (err) {
    console.error("❌ WhatsApp webhook handler error:", err?.message || err);
  }
});

export default router;