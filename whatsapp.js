// whatsapp.js  ✅ QUEUE VERSION (FAST ACK + enqueue jobs)

import express from "express";
import { MongoClient } from "mongodb";
import crypto from "crypto";

import { enqueueMessageJob } from "./services/queue.js";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";
let mongoConnected = false;

// ===============================
// Logging
// ===============================
function log(level, msg, meta = {}) {
  if (level === "error") console.error("❌", msg, meta);
  else if (level === "warn") console.warn("⚠️", msg, meta);
  else console.log("ℹ️", msg, meta);
}

async function connectDB() {
  if (!mongoConnected) {
    log("info", "Connecting to MongoDB...");
    await mongoClient.connect();
    mongoConnected = true;
    log("info", "MongoDB connected");
  }
  return mongoClient.db(dbName);
}

// ===============================
// Helpers
// ===============================
function normalizePhoneDigits(p) {
  return String(p || "").trim().replace(/[^\d]/g, "");
}

// ===============================
// Clients
// ===============================
async function getClientByPhoneNumberId(phoneNumberId) {
  const db = await connectDB();
  return db.collection("Clients").findOne({
    whatsappPhoneNumberId: String(phoneNumberId || "").trim(),
    active: { $ne: false },
  });
}

async function touchClientWebhook(clientMongoId, payload) {
  try {
    const db = await connectDB();
    await db.collection("Clients").updateOne(
      { _id: clientMongoId },
      {
        $set: {
          lastWebhookAt: new Date(),
          lastWebhookType: "whatsapp",
          lastWebhookPayload: payload,
          updatedAt: new Date(),
        },
      }
    );
  } catch (e) {
    log("warn", "Failed to update lastWebhook fields", { err: e.message });
  }
}

// ===============================
// Webhook verification (Meta)
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
// WhatsApp webhook receiver (FAST ACK + QUEUE)
// ===============================
router.post("/", async (req, res) => {
  // ✅ respond immediately
  res.sendStatus(200);

  try {
    const body = req.body;
    const entries = body?.entry || [];
    if (!Array.isArray(entries) || !entries.length) return;

    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const value = change?.value;

        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const client = await getClientByPhoneNumberId(phoneNumberId);
        if (!client) {
          log("warn", "No client matched whatsappPhoneNumberId", { phoneNumberId });
          continue;
        }

        await touchClientWebhook(client._id, {
          clientId: client.clientId,
          phoneNumberId,
          hasMessages: Boolean(value?.messages?.length),
          meta: value?.metadata || null,
        });

        // ignore delivery/read statuses (no messages array)
        const messages = value?.messages || [];
        if (!messages.length) continue;

        const staffDigits = (client.staffNumbers || []).map(normalizePhoneDigits);

        for (const msg of messages) {
          const fromDigits = normalizePhoneDigits(msg?.from);
          const text = msg?.text?.body || "";
          if (!text) continue;

          // ignore staff messages
          if (staffDigits.includes(fromDigits)) {
            log("info", "Ignoring staff message", { from: fromDigits, clientId: client.clientId });
            continue;
          }

          // Use WhatsApp message id (wamid...) for dedupe if present
          const msgId = String(msg?.id || "").trim();
          const eventKey =
            msgId
              ? `whatsapp:${phoneNumberId}:${msgId}`
              : `whatsapp:${phoneNumberId}:${Date.now()}:${crypto.randomUUID()}`;

          const payload = {
            channel: "whatsapp",
            clientId: client.clientId,
            phoneNumberId: String(phoneNumberId),
            waFrom: fromDigits,
            text: String(text),
            eventKey,
            receivedAt: new Date().toISOString(),
          };

          log("info", "Incoming WhatsApp message (queued)", {
            clientId: client.clientId,
            phoneNumberId,
            from: fromDigits,
            eventKey,
            preview: String(text).slice(0, 120),
          });

          const enq = await enqueueMessageJob(payload);
          if (!enq.ok) {
            log("error", "Failed to enqueue WhatsApp job", { clientId: client.clientId, eventKey, error: enq.error });
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ WhatsApp webhook handler error:", err.message);
  }
});

export default router;
