// messenger.js
import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendMessengerReply, sendMarkAsRead } from "./services/messenger.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import Order from "./order.js";
import { notifyClientStaffNewOrder } from "./utils/notifyClientStaffWhatsApp.js";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";
let mongoConnected = false;

// ===============================
// Logging helpers
// ===============================
function log(level, msg, meta = {}) {
  const base = { level, msg, t: new Date().toISOString(), ...meta };
  // keep console readable
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
    // never crash because logging failed
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

// ===============================
// DB
// ===============================
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
// Clients
// ===============================
async function getClientDoc(pageId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const pageIdStr = normalizePageId(pageId);

  let client = await clients.findOne({ pageId: pageIdStr });

  if (!client) {
    log("warn", "Client not found for pageId, creating placeholder", { pageId: pageIdStr });

    client = {
      pageId: pageIdStr,
      messageCount: 0,
      messageLimit: 1000,
      active: true,
      VERIFY_TOKEN: null,
      PAGE_ACCESS_TOKEN: null,
      quotaWarningSent: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await clients.insertOne(client);
    log("info", "Client created for pageId", { pageId: pageIdStr });
  }

  return client;
}

async function incrementMessageCount(pageId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const pageIdStr = normalizePageId(pageId);

  const updated = await clients.findOneAndUpdate(
    { pageId: pageIdStr },
    {
      $inc: { messageCount: 1 },
      $set: { updatedAt: new Date() },
      $setOnInsert: {
        active: true,
        messageLimit: 1000,
        quotaWarningSent: false,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  const doc = updated?.value || (await clients.findOne({ pageId: pageIdStr }));

  if (!doc) {
    log("error", "Failed to increment or create client for pageId", { pageId: pageIdStr });
    throw new Error(`Failed to increment or create client for pageId: ${pageIdStr}`);
  }

  if (doc.messageCount > doc.messageLimit) {
    log("warn", "Message limit reached for pageId", { pageId: pageIdStr, messageCount: doc.messageCount });
    return { allowed: false, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
  }

  const remaining = doc.messageLimit - doc.messageCount;

  if (remaining === 100 && !doc.quotaWarningSent) {
    log("warn", "Only 100 messages left for pageId", { pageId: pageIdStr });
    await sendQuotaWarning(pageIdStr);
    await clients.updateOne({ pageId: pageIdStr }, { $set: { quotaWarningSent: true, updatedAt: new Date() } });
  }

  return { allowed: true, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
}

// ===============================
// Conversation
// ===============================
async function getConversation(pageId, userId) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);
  return db.collection("Conversations").findOne({ pageId: pageIdStr, userId, source: "messenger" });
}

async function saveConversation(pageId, userId, history, lastInteraction) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);

  const client = await db.collection("Clients").findOne({ pageId: pageIdStr });
  if (!client) {
    log("error", "No client found for pageId while saving conversation", { pageId: pageIdStr });
    await logToDb("error", "messenger", "No client found for pageId while saving conversation", { pageId: pageIdStr });
    return;
  }

  await db.collection("Conversations").updateOne(
    { pageId: pageIdStr, userId, source: "messenger" },
    {
      $set: {
        pageId: pageIdStr,
        clientId: client.clientId,
        history,
        lastInteraction,
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

  // NOTE: Using v20.0 explicitly; change if your app uses another version.
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
    // This is the key log you need to debug PSID issues.
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

// ===============================
// Order flow
// ===============================
async function createOrderFlow({ pageId, sender_psid, orderSummaryText, channel = "messenger" }) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);

  const client = await db.collection("Clients").findOne({ pageId: pageIdStr });
  if (!client) throw new Error(`Client not found for pageId=${pageIdStr}`);

  const customer = await db.collection("Customers").findOne({ pageId: pageIdStr, psid: sender_psid });

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
    clientId: client._id,
    payload: {
      customerName: waSafeParam(customerName),
      customerPhone: waSafeParam(customerPhone),
      itemsText: waSafeParam(itemsText),
      notes: waSafeParam(combinedNotes),
      orderId: waSafeParam(fallbackOrderId),
    },
  });

  log("info", "WhatsApp notify result", { pageId: pageIdStr, notifyResult });

  try {
    const order = await Order.create({
      clientId: client._id,
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

    log("info", "Order saved", { pageId: pageIdStr, orderId: String(order._id) });
    return { order, notifyResult };
  } catch (e) {
    log("warn", "Order save failed (WhatsApp already sent)", { pageId: pageIdStr, err: e.message });
    await logToDb("warn", "order", "Order save failed (WhatsApp already sent)", { pageId: pageIdStr, err: e.message });
    return { order: null, notifyResult };
  }
}

// ===============================
// Webhook verification
// ===============================
router.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!mode || !token) {
    log("warn", "Webhook verification missing mode/token");
    return res.sendStatus(403);
  }

  const db = await connectDB();
  const client = await db.collection("Clients").findOne({ VERIFY_TOKEN: token });

  if (mode === "subscribe" && client) {
    log("info", "Webhook verified", { pageId: client.pageId });
    return res.status(200).send(challenge);
  }

  log("warn", "Webhook verification failed", { mode, tokenProvided: true });
  return res.sendStatus(403);
});

// ===============================
// Messenger webhook receiver
// ===============================
router.post("/", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // respond fast
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry || []) {
    const pageId = normalizePageId(entry.id);

    // IMPORTANT: there can be multiple events in entry.messaging
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

      // Key debug: token/PSID issues are often "pageId mismatch"
      if (recipient_page_id && recipient_page_id !== pageId) {
        log("warn", "PageId mismatch between entry.id and recipient.id", metaBase);
        await logToDb("warn", "messenger", "PageId mismatch between entry.id and recipient.id", metaBase);
      }

      try {
        const clientDoc = await getClientDoc(pageId);

        if (clientDoc.active === false) continue;

        if (!clientDoc.PAGE_ACCESS_TOKEN) {
          log("warn", "Client has no PAGE_ACCESS_TOKEN", { ...metaBase, clientPageId: clientDoc.pageId });
          await logToDb("warn", "messenger", "Client has no PAGE_ACCESS_TOKEN", { ...metaBase, clientPageId: clientDoc.pageId });
        }

        // ===== Attachment handler
        if (webhook_event.message?.attachments?.length > 0) {
          await sendMessengerReply(
            sender_psid,
            "Could you describe what's in the image, or say the name of the item u are looking for so I can help you better?",
            pageId
          );
          continue;
        }

        // ===== Text message
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

          // Auto-resume bot if timer expired
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

          // Resume bot command
          if (userMessage.trim().toLowerCase() === "!bot") {
            await db.collection("Conversations").updateOne(
              { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
              {
                $set: {
                  humanEscalation: false,
                  botResumeAt: null,
                  resumedBy: "customer",
                  resumedAt: new Date(),
                },
              },
              { upsert: true }
            );

            await sendMessengerReply(sender_psid, "✅ Bot is reactivated!", pageId);
            continue;
          }

          // If human escalation active → ignore bot
          if (convoCheck?.humanEscalation === true) {
            log("info", "Human escalation active; bot ignoring message", metaBase);
            continue;
          }

          async function processMessageWithTyping() {
            let convo, history, greeting, firstName;

            const finalSystemPrompt = await SYSTEM_PROMPT({ pageId });
            convo = await getConversation(pageId, sender_psid);
            history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

            firstName = "there";
            greeting = "";

            // If new day, try to fetch profile (this is where your PSID fetch was failing)
            if (!convo || isNewDay(convo.lastInteraction)) {
              const userProfile = await getUserProfile(sender_psid, clientDoc.PAGE_ACCESS_TOKEN, {
                ...metaBase,
                clientPageId: clientDoc.pageId,
              });

              firstName = userProfile.first_name || "there";
              await saveCustomer(pageId, sender_psid, userProfile);

              greeting = `Hi ${firstName}, good to see you today 👋`;

              // IMPORTANT: Avoid double-sending greeting:
              // - We'll send greeting + assistant reply as one message
              // - We do NOT push greeting as a separate assistant turn to history
              // If you want the model to "see" greeting in history, you can add it back.
            }

            history.push({ role: "user", content: userMessage, createdAt: new Date() });

            const usage = await incrementMessageCount(pageId);
            if (!usage.allowed) {
              await sendMessengerReply(sender_psid, "⚠️ Message limit reached.", pageId);
              return;
            }

            let assistantMessage;
            try {
              assistantMessage = await getChatCompletion(history);
            } catch (err) {
              log("error", "OpenAI error", { ...metaBase, err: err.message });
              await logToDb("error", "openai", err.message, metaBase);
              assistantMessage = "⚠️ I'm having trouble right now. Please try again shortly.";
            }

            // Control tokens parsing
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
                { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
                {
                  $set: {
                    humanEscalation: true,
                    botResumeAt,
                    humanEscalationStartedAt: new Date(),
                  },
                  $inc: { humanRequestCount: 1 },
                },
                { upsert: true }
              );

              log("warn", "Human escalation triggered", metaBase);

              await sendMessengerReply(
                sender_psid,
                "👤 A human agent will take over shortly.\nYou can type !bot anytime to return to the assistant.\n\nسيقوم أحد موظفي الدعم بالرد عليك قريبًا.",
                pageId
              );
              return;
            }

            // Order handling
            if (flags.order) {
              await db.collection("Conversations").updateOne(
                { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
                { $inc: { orderRequestCount: 1 } },
                { upsert: true }
              );

              try {
                await createOrderFlow({
                  pageId,
                  sender_psid,
                  orderSummaryText: assistantMessage,
                  channel: "messenger",
                });

                await sendMessengerReply(
                  sender_psid,
                  "✅ Your order request has been received.\nA staff member will contact you shortly.\n\nتم استلام طلبك وسيتم التواصل معك قريبًا.",
                  pageId
                );
                return;
              } catch (err) {
                log("error", "Order flow failed", { ...metaBase, err: err.message });
                await logToDb("error", "order", "Order flow failed", { ...metaBase, err: err.message });

                await sendMessengerReply(
                  sender_psid,
                  "⚠️ We couldn't process your order right now. Please try again.",
                  pageId
                );
                return;
              }
            }

            // Tour counter
            if (flags.tour) {
              await db.collection("Conversations").updateOne(
                { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
                { $inc: { tourRequestCount: 1 } },
                { upsert: true }
              );
            }

            // Save conversation (clean)
            history.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
            await saveConversation(pageId, sender_psid, history, new Date());

            // Combine greeting (only for user-facing message)
            const combinedMessage = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;

            // Send reply
            await sendMessengerReply(sender_psid, combinedMessage, pageId);

            log("info", "Reply sent", { ...metaBase, replyPreview: combinedMessage.slice(0, 120) });
          }

          // mark as read while processing
          await sendMarkAsRead(sender_psid, pageId);
          await new Promise((resolve) => setTimeout(resolve, 1200));

          await processMessageWithTyping().catch(async (err) => {
            log("error", "Processing error", { ...metaBase, err: err.message });
            await logToDb("error", "messenger", "Processing error", { ...metaBase, err: err.message });

            try {
              await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", pageId);
            } catch {}
          });
        }

        // ===== Postbacks
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
