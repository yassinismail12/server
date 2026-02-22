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
// Clients
// ===============================
async function getClientByPhoneNumberId(whatsappPhoneNumberId) {
  const db = await connectDB();
  return db.collection("Clients").findOne({
    whatsappPhoneNumberId: String(whatsappPhoneNumberId || "").trim(),
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
        source: "whatsapp", // ✅ dashboard filter key
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
  // Log immediately so you can confirm Meta is hitting this endpoint
  
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

        const whatsappPhoneNumberId = "1044259142098481";
        if (!whatsappPhoneNumberId) {
          log("warn", "Missing metadata.phone_number_id", { valueKeys: Object.keys(value || {}) });
          continue;
        }

        // Find client by whatsappPhoneNumberId (same field name as in Mongo)
        const client = await getClientByPhoneNumberId(whatsappPhoneNumberId);
        if (!client) {
          log("warn", "No client matched whatsappPhoneNumberId", { whatsappPhoneNumberId });
          continue;
        }

        // Keep variable names exactly as in Mongo schema
        const whatsappAccessToken = client.whatsappAccessToken || "";
        const whatsappConnectedAt = client.whatsappConnectedAt || null;
        const whatsappVerifiedName = client.whatsappVerifiedName || "";
        
        const whatsappDisplayPhone = client.whatsappDisplayPhone || "";
        const whatsappTokenExpiresAt = client.whatsappTokenExpiresAt || null;
        const whatsappTokenType = client.whatsappTokenType || "";
        const whatsappWabaId = client.whatsappWabaId || "";

        // IG fields (not used by WA flow, but logged so you can verify values exist)
        const igName = client.igName || "";
        const igProfilePicUrl = client.igProfilePicUrl || "";
        const igUsername = client.igUsername || "";
        const igBusinessId = client.igBusinessId || client.igId || "";
        const igIdentityUpdatedAt = client.igIdentityUpdatedAt || null;
        const lastIgSenderAt = client.lastIgSenderAt || null;
        const lastIgSenderId = client.lastIgSenderId || "";
        const lastIgSenderText = client.lastIgSenderText || "";

        // Log the connection snapshot once per webhook batch
        log("info", "Client matched for WA webhook", {
          clientId: client.clientId,
          whatsappPhoneNumberId,
          whatsappWabaId,
          whatsappDisplayPhone,
          whatsappVerifiedName,
          whatsappTokenType,
          whatsappTokenExpiresAt,
          whatsappConnectedAt,
          igBusinessId,
          igUsername,
        });

        if (!whatsappAccessToken) {
          log("warn", "Client has no whatsappAccessToken (Embedded Signup not finished)", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
          });
          continue;
        }

        // Store last webhook payload on the client for debugging (dashboard "View Last Payload")
        await touchClientWebhook(client._id, {
          clientId: client.clientId,
          whatsappPhoneNumberId,
          hasMessages: Boolean(value?.messages?.length),
          meta: value?.metadata || null,
          // include some ids to help debug
          whatsappWabaId,
          whatsappDisplayPhone,
          whatsappTokenType,
          igBusinessId,
          igUsername,
          igName,
          igProfilePicUrl,
          igIdentityUpdatedAt,
          lastIgSenderAt,
          lastIgSenderId,
          lastIgSenderText,
        });

        // Ignore delivery/read statuses: only respond to inbound messages
        const messages = value?.messages || [];
        if (!messages.length) {
          log("info", "No inbound messages in webhook (likely statuses)", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
          });
          continue;
        }

        // Staff digits list (ignore staff inbound)
        const staffDigits = (client.staffNumbers || []).map(normalizePhoneDigits);

        // Client-level awaitSource switch (optional)
        const clientAwaitSource = Boolean(client.awaitSource);

        for (const msg of messages) {
          // Log raw message summary
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

          // ignore staff messages
          if (staffDigits.includes(fromDigits)) {
            log("info", "Ignoring staff message", { from: fromDigits, clientId: client.clientId });
            continue;
          }

          // Load convo
          const convo = await getConversation(client.clientId, fromDigits);

          // If human escalation is ON, ignore bot
          if (convo?.humanEscalation === true) {
            log("info", "Human escalation active; ignoring", { from: fromDigits, clientId: client.clientId });
            continue;
          }

          // greeting / timestamps
          const inboundAt = new Date();
          const inboundPreview = text.slice(0, 200);

          // default history (system prompt)
          const systemPrompt = buildSystemPromptFromClient(client);
          let history = convo?.history || [{ role: "system", content: systemPrompt }];

          // ====== AWAIT SOURCE MODE ======
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
                meta: {
                  whatsappPhoneNumberId,
                  whatsappWabaId,
                  whatsappDisplayPhone,
                  whatsappTokenType,
                  whatsappTokenExpiresAt,
                },
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

              log("info", "Awaiting source choice", { from: fromDigits, clientId: client.clientId });
              continue;
            }

            // user chose a source → store it and proceed
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
              meta: {
                whatsappPhoneNumberId,
                whatsappWabaId,
                whatsappDisplayPhone,
                whatsappTokenType,
                whatsappTokenExpiresAt,
              },
            });

            log("info", "Sending source selection confirmation", {
              clientId: client.clientId,
              to: fromDigits,
              picked,
            });

            await sendWhatsAppText({
              phoneNumberId: whatsappPhoneNumberId,
              to: fromDigits,
              text: `✅ Got it. You selected: ${picked}.\nHow can I help you?`,
              accessToken: whatsappAccessToken,
            });

            log("info", "Source choice selected", { from: fromDigits, picked, clientId: client.clientId });
            continue;
          }

          // ====== NORMAL BOT FLOW ======
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

          // persist assistant turn
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
            meta: {
              whatsappPhoneNumberId,
              whatsappWabaId,
              whatsappDisplayPhone,
              whatsappTokenType,
              whatsappTokenExpiresAt,
            },
          });

          log("info", "Sending WA reply", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
            to: fromDigits,
            preview: combined.slice(0, 80),
          });

          await sendWhatsAppText({
            phoneNumberId: whatsappPhoneNumberId,
            to: fromDigits,
            text: combined,
            accessToken: whatsappAccessToken,
          });

          log("info", "WhatsApp reply sent", {
            clientId: client.clientId,
            whatsappPhoneNumberId,
            to: fromDigits,
            preview: combined.slice(0, 80),
          });
        }
      }
    }
  } catch (err) {
    // If Meta isn't hitting this route, you won't see this.
    console.error("❌ WhatsApp webhook handler error:", err?.message || err);
  }
});

export default router;