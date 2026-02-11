// messenger.js  ✅ QUEUE VERSION (fast webhook ACK + enqueue jobs)
//
// What changed vs your original:
// - Removed retrieval/OpenAI work from webhook (no more slow processing inside webhook)
// - Kept: DB logging, VERIFY_TOKEN verification, idempotency, unknown-page guard
// - Text messages now: mark as read + enqueueMessageJob({ clientId, pageId, psid, text, eventKey })
// - Attachments + postbacks still handled instantly (simple replies)

import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";
import crypto from "crypto";

import { enqueueMessageJob } from "./services/queue.js";
import { sendMessengerReply, sendMarkAsRead } from "./services/messenger.js";

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
    // Idempotency store: unique (pageId + eventKey) + TTL
    const col = db.collection("ProcessedEvents");
    await col.createIndex({ pageId: 1, eventKey: 1 }, { unique: true });
    await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // 24h
  } catch (e) {
    console.warn("⚠️ ensureIndexes failed:", e.message);
  }
}

async function connectDB() {
  if (!mongoConnected) {
    log("info", "Connecting to MongoDB...");
    await mongoClient.connect();
    mongoConnected = true;
    log("info", "MongoDB connected");

    // Best-effort index creation
    try {
      const db = mongoClient.db(dbName);
      await ensureIndexes(db);
    } catch {}
  }
  return mongoClient.db(dbName);
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

  // fallback for text-only events without mid (rare)
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

/**
 * Fetch client by pageId.
 * ✅ DOES NOT create placeholder clients.
 * ✅ Ensures clientId exists (backfills) if client is found.
 */
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
// Messenger webhook receiver (FAST ACK + QUEUE)
// ===============================
router.post("/", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // ✅ respond fast
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry || []) {
    const pageId = normalizePageId(entry.id);

    // ✅ Only process events for onboarded clients (NO auto-create)
    const clientForEntry = await getClientByPageId(pageId);
    if (!clientForEntry) {
      log("warn", "Webhook event for unknown pageId; ignoring", { pageId });
      await logToDb("warn", "messenger", "Webhook event for unknown pageId; ignoring", { pageId });
      continue;
    }
    if (clientForEntry.active === false) continue;

    // Track webhook freshness (best effort)
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
      };

      if (recipient_page_id && recipient_page_id !== pageId) {
        log("warn", "PageId mismatch between entry.id and recipient.id", metaBase);
        await logToDb("warn", "messenger", "PageId mismatch between entry.id and recipient.id", metaBase);
      }

      // ✅ Idempotency
      const rawEventKey = buildEventKey(webhook_event);
      if (rawEventKey && (await wasProcessed(pageId, rawEventKey))) {
        log("info", "Skipping duplicate webhook event", { ...metaBase, eventKey: rawEventKey });
        continue;
      }
      await markProcessed(pageId, rawEventKey, metaBase);

      try {
        // refresh client doc (ensure latest token/settings)
        const clientDoc = await getClientByPageId(pageId);
        if (!clientDoc) continue;
        if (clientDoc.active === false) continue;

        // ===== Attachment handler (instant reply, no AI)
        if (webhook_event.message?.attachments?.length > 0) {
          await sendMessengerReply(
            sender_psid,
            "Could you describe what's in the image, or say the name of the item u are looking for so I can help you better?",
            pageId
          );
          continue;
        }

        // ===== Text message: enqueue job
        if (webhook_event.message?.text) {
          const userMessage = String(webhook_event.message.text || "");
          const pageIdStr = normalizePageId(pageId);

          log("info", "Incoming message (queued)", {
            ...metaBase,
            eventKey: rawEventKey,
            textPreview: userMessage.slice(0, 120),
            clientId: clientDoc.clientId,
          });

          // mark as read (best effort)
          try {
            await sendMarkAsRead(sender_psid, pageIdStr);
          } catch {}

          // Unique job id for dedupe at queue level too
          const eventKey = `messenger:${pageIdStr}:${rawEventKey || `${Date.now()}:${sender_psid}`}`;

          const payload = {
            channel: "messenger",
            clientId: clientDoc.clientId, // ✅ tenant
            pageId: pageIdStr,
            psid: sender_psid,
            text: userMessage,
            eventKey,
            receivedAt: new Date().toISOString(),
          };

          const enq = await enqueueMessageJob(payload);
          if (!enq.ok) {
            log("error", "Failed to enqueue messenger job", { ...metaBase, eventKey, error: enq.error });
            await logToDb("error", "queue", "Failed to enqueue messenger job", {
              ...metaBase,
              eventKey,
              error: enq.error,
            });

            // fallback message (don’t break webhook)
            try {
              await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", pageIdStr);
            } catch {}
          }

          continue;
        }

        // ===== Postbacks (instant canned replies)
        if (webhook_event.postback?.payload) {
          const payload = webhook_event.postback.payload;

          const responses = {
            ICE_BREAKER_PROPERTIES: "Sure! What type of property are you looking for and in which area?",
            ICE_BREAKER_BOOK: "You can book a visit by telling me the property you're interested in.",
            ICE_BREAKER_PAYMENT: "Yes! We offer several payment plans. What’s your budget or preferred duration?",
          };

          if (responses[payload]) {
            try {
              await sendMarkAsRead(sender_psid, pageId);
            } catch {}
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
