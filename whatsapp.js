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
  // customize this to your business
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

  log("warn", "WhatsApp webhook verification failed", { mode, tokenProvided: Boolean(token) });
  return res.sendStatus(403);
});

// ===============================
// WhatsApp webhook receiver
// ===============================
router.post("/", async (req, res) => {
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

        // ignore delivery/read statuses
        const messages = value?.messages || [];
        if (!messages.length) continue;

        const staffDigits = (client.staffNumbers || []).map(normalizePhoneDigits);
        const clientAwaitSource = Boolean(client.awaitSource); // ✅ put this in Mongo if you want

        for (const msg of messages) {
          const fromDigits = normalizePhoneDigits(msg?.from);
          const text = msg?.text?.body || "";
          if (!text) continue;

          // ignore staff messages
          if (staffDigits.includes(fromDigits)) {
            log("info", "Ignoring staff message", { from: fromDigits, clientId: client.clientId });
            continue;
          }

          const convo = await getConversation(client.clientId, fromDigits);

          // if human escalation is ON, ignore bot
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
          // If client.awaitSource is true AND convo has no sourceChoice yet:
          const sourceChoiceExisting = convo?.sourceChoice || "";
          const needsChoice = clientAwaitSource && !sourceChoiceExisting;

          if (needsChoice) {
            // user picked a choice?
            const picked = parseSourceChoice(text);

            if (!picked) {
              // send menu again (once per day or first message)
              const shouldSendMenu =
                !convo || isNewDay(convo.lastInteraction) || convo?.awaitSource !== true;

              // save convo state with awaitSource=true
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
                meta: { phoneNumberId },
              });

              if (shouldSendMenu) {
                await sendWhatsAppText({
                  phoneNumberId,
                  to: fromDigits,
                  text: sourceMenuText(),
                });
              }

              log("info", "Awaiting source choice", { from: fromDigits, clientId: client.clientId });
              continue;
            }

            // user chose a source → store it and proceed normally
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
              meta: { phoneNumberId },
            });

            await sendWhatsAppText({
              phoneNumberId,
              to: fromDigits,
              text: `✅ Got it. You selected: ${picked}.\nHow can I help you?`,
            });

            log("info", "Source choice selected", { from: fromDigits, picked, clientId: client.clientId });
            continue;
          }

          // ====== NORMAL BOT FLOW ======
          let greeting = "";
          if (!convo || isNewDay(convo.lastInteraction)) greeting = "Hi 👋";

          history.push({ role: "user", content: text, createdAt: inboundAt });

          let assistantMessage;
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
            lastMessage: inboundPreview, // show last customer text in inbox list
            lastMessageAt: inboundAt,
            lastDirection: "in",
            awaitSource: false,
            sourceChoice: convo?.sourceChoice || "",
            meta: { phoneNumberId },
          });

          await sendWhatsAppText({
            phoneNumberId,
            to: fromDigits,
            text: combined,
          });

          log("info", "WhatsApp reply sent", {
            clientId: client.clientId,
            phoneNumberId,
            to: fromDigits,
            preview: combined.slice(0, 80),
          });
        }
      }
    }
  } catch (err) {
    console.error("❌ WhatsApp webhook handler error:", err.message);
  }
});

export default router;
