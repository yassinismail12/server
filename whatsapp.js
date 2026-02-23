// whatsapp.js
import express from "express";
import { MongoClient } from "mongodb";

import { getChatCompletion } from "./services/openai.js";
import { sendWhatsAppText } from "./services/whatsappText.js";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";
let mongoConnected = false;

// ===============================
// Logging
// ===============================
function log(level, msg, meta = {}) {
  const base = { t: new Date().toISOString(), msg, ...meta };
  if (level === "error") console.error("❌", base);
  else if (level === "warn") console.warn("⚠️", base);
  else console.log("ℹ️", base);
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

function buildSystemPromptFromClient(client) {
  const base = client.systemPrompt || "You are a helpful assistant.";
  const faqs = client.faqs ? `\n\nFAQs:\n${client.faqs}` : "";
  const listings = client.listingsData ? `\n\nListings:\n${client.listingsData}` : "";
  const plans = client.paymentPlans ? `\n\nPayment Plans:\n${client.paymentPlans}` : "";
  return `${base}${faqs}${listings}${plans}`.trim();
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
// Token selection (System User token)
// ===============================
// If you only have ONE portfolio/token, set WHATSAPP_SYSTEM_USER_TOKEN in Render env.
// If you have 2 portfolios, set both and store client.whatsappTokenKey = "bm2" for example.
function getSystemTokenForClient(client) {
  const key = String(client?.whatsappTokenKey || "").trim().toLowerCase();

  if (key && process.env[`WHATSAPP_TOKEN_${key.toUpperCase()}`]) {
    return process.env[`WHATSAPP_TOKEN_${key.toUpperCase()}`];
  }
  return process.env.WHATSAPP_TOKEN || "";
}
// ===============================
// Clients
// ===============================
async function getClientByPhoneNumberId(whatsappPhoneNumberId) {
  const db = await connectDB();
  return db.collection("Clients").findOne({
    whatsappPhoneNumberId: String(whatsappPhoneNumberId || "").trim(),
    active: { $ne: false },
  });
}

// Optional: used by send-test endpoint
async function getClientByClientId(clientId) {
  const db = await connectDB();
  return db.collection("Clients").findOne({
    clientId: String(clientId || "").trim(),
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
        },
      }
    );
  } catch (e) {
    log("warn", "Failed to update lastWebhook fields", { err: e.message });
  }
}

// ===============================
// Conversations (stored with source: "whatsapp")
// ===============================
async function getConversation(clientId, userId) {
  const db = await connectDB();
  return db.collection("Conversations").findOne({
    clientId: String(clientId),
    userId,
    source: "whatsapp",
  });
}

async function upsertConversation({
  clientId,
  userId,
  history,
  lastInteraction,
  lastMessage,
  lastMessageAt,
  lastDirection,
  awaitSource,
  sourceChoice,
  meta = {},
}) {
  const db = await connectDB();
  await db.collection("Conversations").updateOne(
    { clientId: String(clientId), userId, source: "whatsapp" },
    {
      $set: {
        clientId: String(clientId),
        userId,
        source: "whatsapp",
        sourceLabel: "WhatsApp",
        history,
        lastInteraction,
        lastMessage: lastMessage || "",
        lastMessageAt: lastMessageAt || lastInteraction,
        lastDirection: lastDirection || "",
        awaitSource: Boolean(awaitSource),
        sourceChoice: sourceChoice || "",
        meta: { ...(meta || {}) },
        updatedAt: new Date(),
      },
      $setOnInsert: {
        humanEscalation: false,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

// ===============================
// Admin auth for test route
// ===============================


// ===============================
// ✅ TEST SEND ENDPOINT (like IG)
// POST /whatsapp/send-test
// body: { clientId, to, text }
// ===============================
router.post("/send-test", async (req, res) => {
  try {
    // ✅ rely on your existing login session
    // If you don't have req.user here, see note below.
    if (!req.user || req.user.role !== "client") {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { clientId, to, text } = req.body || {};
    const toDigits = normalizePhoneDigits(to);

    if (!clientId || !toDigits || !text) {
      return res.status(400).json({ ok: false, error: "Missing clientId, to, or text" });
    }

    // ✅ don't allow sending for a different clientId
    if (String(clientId) !== String(req.user.clientId)) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const client = await getClientByClientId(clientId);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const phoneNumberId = String(client.whatsappPhoneNumberId || "").trim();
    if (!phoneNumberId) {
      return res.status(400).json({ ok: false, error: "Client missing whatsappPhoneNumberId" });
    }

    const accessToken = getSystemTokenForClient(client);
    if (!accessToken) {
      return res.status(500).json({ ok: false, error: "Missing WHATSAPP token env" });
    }

    await sendWhatsAppText({
      phoneNumberId,
      to: toDigits,
      text: String(text),
      accessToken,
    });

    return res.json({ ok: true });
  } catch (e) {
    log("error", "WA send-test failed", { err: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
});

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

  log("warn", "WhatsApp webhook verification failed", {
    mode,
    tokenProvided: Boolean(token),
  });
  return res.sendStatus(403);
});

// ===============================
// WhatsApp webhook receiver
// ===============================
router.post("/", async (req, res) => {
  console.log("🔥 WA POST HIT", new Date().toISOString(), "keys:", Object.keys(req.body || {}));

  log("info", "🔥 WHATSAPP WEBHOOK HIT", {
    hasBody: Boolean(req.body),
    topKeys: Object.keys(req.body || {}),
  });

  // Reply to Meta fast
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
          log("warn", "No client matched whatsappPhoneNumberId", { whatsappPhoneNumberId });
          continue;
        }

        // ✅ Use SYSTEM USER TOKEN (stable)
        const whatsappAccessToken = getSystemTokenForClient(client);

        const whatsappConnectedAt = client.whatsappConnectedAt || null;
        const whatsappVerifiedName = client.whatsappVerifiedName || "";
        const whatsappDisplayPhone = client.whatsappDisplayPhone || "";
        const whatsappTokenExpiresAt = client.whatsappTokenExpiresAt || null;
        const whatsappTokenType = client.whatsappTokenType || "system_user";
        const whatsappWabaId = client.whatsappWabaId || "";

        log("info", "Client matched for WA webhook", {
          clientId: client.clientId,
          whatsappPhoneNumberId,
          whatsappWabaId,
          whatsappDisplayPhone,
          whatsappVerifiedName,
          whatsappTokenType,
          whatsappTokenExpiresAt,
          whatsappConnectedAt,
          whatsappTokenKey: client.whatsappTokenKey || "",
        });

        if (!whatsappAccessToken) {
          log("warn", "Missing system user token env for this client", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
            tokenKey: client.whatsappTokenKey || "",
          });
          continue;
        }

        await touchClientWebhook(client._id, {
          clientId: client.clientId,
          whatsappPhoneNumberId,
          hasMessages: Boolean(value?.messages?.length),
          meta: value?.metadata || null,
          whatsappWabaId,
          whatsappDisplayPhone,
          whatsappTokenType,
        });

        const messages = value?.messages || [];
        if (!messages.length) {
          log("info", "No inbound messages in webhook (likely statuses)", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
          });
          continue;
        }

        const staffDigits = (client.staffNumbers || []).map(normalizePhoneDigits);
        const clientAwaitSource = Boolean(client.awaitSource);

        for (const msg of messages) {
          log("info", "Inbound WA message", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
            from: msg?.from,
            type: msg?.type,
            msgId: msg?.id,
          });

          const fromDigits = normalizePhoneDigits(msg?.from);
          const text = msg?.text?.body || "";

          if (!fromDigits) {
            log("warn", "Message missing from", { msg: msg?.id });
            continue;
          }
          if (!text) {
            log("info", "Ignoring non-text message", { clientId: client.clientId, from: fromDigits, type: msg?.type });
            continue;
          }
          if (staffDigits.includes(fromDigits)) {
            log("info", "Ignoring staff message", { from: fromDigits, clientId: client.clientId });
            continue;
          }

          const convo = await getConversation(client.clientId, fromDigits);

          if (convo?.humanEscalation === true) {
            log("info", "Human escalation active; ignoring", { from: fromDigits, clientId: client.clientId });
            continue;
          }

          const inboundAt = new Date();
          const inboundPreview = text.slice(0, 200);

          const systemPrompt = buildSystemPromptFromClient(client);
          let history = convo?.history || [{ role: "system", content: systemPrompt }];

          const sourceChoiceExisting = convo?.sourceChoice || "";
          const needsChoice = clientAwaitSource && !sourceChoiceExisting;

          if (needsChoice) {
            const picked = parseSourceChoice(text);

            if (!picked) {
              const shouldSendMenu = !convo || isNewDay(convo.lastInteraction) || convo?.awaitSource !== true;

              history.push({ role: "user", content: text, createdAt: inboundAt });

              await upsertConversation({
                clientId: client.clientId,
                userId: fromDigits,
                history,
                lastInteraction: inboundAt,
                lastMessage: inboundPreview,
                lastMessageAt: inboundAt,
                lastDirection: "in",
                awaitSource: true,
                sourceChoice: "",
                meta: { whatsappPhoneNumberId, whatsappWabaId, whatsappDisplayPhone, whatsappTokenType },
              });

              if (shouldSendMenu) {
                log("info", "Sending source menu", { clientId: client.clientId, to: fromDigits });
                await sendWhatsAppText({
                  phoneNumberId: whatsappPhoneNumberId,
                  to: fromDigits,
                  text: sourceMenuText(),
                  accessToken: whatsappAccessToken,
                });
              }
              continue;
            }

            history.push({ role: "user", content: text, createdAt: inboundAt });

            await upsertConversation({
              clientId: client.clientId,
              userId: fromDigits,
              history,
              lastInteraction: inboundAt,
              lastMessage: inboundPreview,
              lastMessageAt: inboundAt,
              lastDirection: "in",
              awaitSource: false,
              sourceChoice: picked,
              meta: { whatsappPhoneNumberId, whatsappWabaId, whatsappDisplayPhone, whatsappTokenType },
            });

            await sendWhatsAppText({
              phoneNumberId: whatsappPhoneNumberId,
              to: fromDigits,
              text: `✅ Got it. You selected: ${picked}.\nHow can I help you?`,
              accessToken: whatsappAccessToken,
            });

            continue;
          }

          let greeting = "";
          if (!convo || isNewDay(convo.lastInteraction)) greeting = "Hi 👋";

          history.push({ role: "user", content: text, createdAt: inboundAt });

          let assistantMessage = "";
          try {
            assistantMessage = await getChatCompletion(history);
          } catch (err) {
            log("error", "OpenAI error", { err: err.message, clientId: client.clientId, from: fromDigits });
            assistantMessage = "⚠️ I'm having trouble right now. Please try again shortly.";
          }

          const combined = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;

          const outboundAt = new Date();
          history.push({ role: "assistant", content: assistantMessage, createdAt: outboundAt });

          await upsertConversation({
            clientId: client.clientId,
            userId: fromDigits,
            history,
            lastInteraction: outboundAt,
            lastMessage: inboundPreview,
            lastMessageAt: inboundAt,
            lastDirection: "in",
            awaitSource: false,
            sourceChoice: convo?.sourceChoice || "",
            meta: { whatsappPhoneNumberId, whatsappWabaId, whatsappDisplayPhone, whatsappTokenType },
          });

          log("info", "Sending WA reply", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
            to: fromDigits,
            preview: combined.slice(0, 80),
          });

          try {
            await sendWhatsAppText({
              phoneNumberId: whatsappPhoneNumberId,
              to: fromDigits,
              text: combined,
              accessToken: whatsappAccessToken,
            });
          } catch (e) {
            log("error", "WhatsApp send failed", {
              clientId: client.clientId,
              to: fromDigits,
              err: e.message,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ WhatsApp webhook handler error:", err?.message || err);
  }
});

export default router;