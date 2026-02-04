// messenger.js
import express from "express";
import fetch from "node-fetch";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendMessengerReply, sendMarkAsRead } from "./services/messenger.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import Order from "./order.js";
import { notifyClientStaffNewOrder } from "./utils/notifyClientStaffWhatsApp.js";
import { MongoClient } from "mongodb";

const router = express.Router();
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== Helper to normalize pageId =====
function normalizePageId(id) {
  return String(id || "").trim();
}

// ===== DB Connection =====
async function connectDB() {
  // NOTE: mongodb driver versions differ; this is a safe-ish check
  if (!mongoClient.topology?.isConnected?.()) {
    console.log("🔗 Connecting to MongoDB...");
    await mongoClient.connect();
    console.log("✅ MongoDB connected");
  }
  return mongoClient.db(dbName);
}

// ===== Clients =====
async function getClientDoc(pageId) {
  const db = await connectDB();
  const clients = db.collection("Clients");

  const pageIdStr = normalizePageId(pageId);

  let client = await clients.findOne({ pageId: pageIdStr });

  if (!client) {
    console.warn("⚠️ Client not found for pageId:", pageIdStr);
    client = {
      pageId: pageIdStr,
      messageCount: 0,
      messageLimit: 1000,
      active: true,
      VERIFY_TOKEN: null,
      PAGE_ACCESS_TOKEN: null,
      quotaWarningSent: false,
    };
    await clients.insertOne(client);
    console.log("✅ Client created for pageId:", pageIdStr);
  }

  console.log("📄 Client loaded:", {
    pageId: pageIdStr,
    active: client.active !== false,
    hasPageToken: Boolean(client.PAGE_ACCESS_TOKEN),
    tokenLength: client.PAGE_ACCESS_TOKEN ? client.PAGE_ACCESS_TOKEN.length : 0,
  });

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
      $setOnInsert: {
        active: true,
        messageLimit: 1000,
        quotaWarningSent: false,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  const doc = updated.value || (await clients.findOne({ pageId: pageIdStr }));

  if (!doc) {
    console.error("❌ Still could not find or create client for pageId:", pageIdStr);
    throw new Error(`Failed to increment or create client for pageId: ${pageIdStr}`);
  }

  if (doc.messageCount > doc.messageLimit) {
    console.warn("❌ Message limit reached for pageId:", pageIdStr);
    return { allowed: false, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
  }

  const remaining = doc.messageLimit - doc.messageCount;

  if (remaining === 100 && !doc.quotaWarningSent) {
    console.warn("⚠️ Only 100 messages left for pageId:", pageIdStr);
    await sendQuotaWarning(pageIdStr);
    await clients.updateOne({ pageId: pageIdStr }, { $set: { quotaWarningSent: true } });
  }

  return { allowed: true, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
}

// ===== Conversation =====
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
    console.error("❌ No client found for pageId:", pageIdStr);
    return;
  }

  await db.collection("Conversations").updateOne(
    { pageId: pageIdStr, userId, source: "messenger" },
    {
      $set: {
        pageId: pageIdStr,
        clientId: client.clientId, // keep your existing field
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
    },
    { upsert: true }
  );
}

// ===== Helpers =====
function isNewDay(lastDate) {
  const today = new Date();
  return (
    !lastDate ||
    lastDate.getDate() !== today.getDate() ||
    lastDate.getMonth() !== today.getMonth() ||
    lastDate.getFullYear() !== today.getFullYear()
  );
}

// ===== Token debug: ensure token belongs to the same page =====
async function assertTokenMatchesPage(pageAccessToken, expectedPageId) {
  const expected = normalizePageId(expectedPageId);

  if (!pageAccessToken) {
    console.warn("⚠️ No PAGE_ACCESS_TOKEN on client doc");
    return { ok: false, reason: "missing_token" };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/me?fields=id,name&access_token=${pageAccessToken}`
    );
    const txt = await res.text();
    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      data = { raw: txt };
    }

    console.log("🔐 Token /me debug:", data);

    if (!res.ok || !data?.id) {
      return { ok: false, reason: "token_invalid", data };
    }

    if (normalizePageId(data.id) !== expected) {
      console.error("❌ Wrong PAGE_ACCESS_TOKEN for this pageId:", {
        expectedPageId: expected,
        tokenPageId: String(data.id),
        tokenPageName: data.name,
      });
      return { ok: false, reason: "token_wrong_page", data };
    }

    return { ok: true, page: data };
  } catch (e) {
    console.error("❌ Token debug failed:", e.message);
    return { ok: false, reason: "token_debug_exception" };
  }
}

// ===== Users (Messenger profile fetch) =====
async function getUserProfile(psid, pageAccessToken) {
  if (!pageAccessToken) return { first_name: "there" };

  const url = `https://graph.facebook.com/v20.0/${psid}?fields=first_name,last_name&access_token=${pageAccessToken}`;
  const res = await fetch(url);

  if (!res.ok) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      const txt = await res.text();
      console.error("❌ getUserProfile raw error:", txt);
      return { first_name: "there" };
    }

    console.error("❌ getUserProfile error:", {
      status: res.status,
      message: payload?.error?.message,
      code: payload?.error?.code,
      subcode: payload?.error?.error_subcode,
      fbtrace_id: payload?.error?.fbtrace_id,
    });

    return { first_name: "there" };
  }

  return res.json();
}


// ===== Webhook verification =====
router.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!mode || !token) {
    console.warn("❌ Webhook verification missing mode/token");
    return res.sendStatus(403);
  }

  const db = await connectDB();
  const client = await db.collection("Clients").findOne({ VERIFY_TOKEN: token });

  if (mode === "subscribe" && client) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook verification failed");
  return res.sendStatus(403);
});

// ===== Order parsing helpers =====
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

async function createOrderFlow({ pageId, sender_psid, orderSummaryText, channel = "messenger" }) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);

  const client = await db.collection("Clients").findOne({ pageId: pageIdStr });
  if (!client) throw new Error(`Client not found for pageId=${pageIdStr}`);

  const customer = await db.collection("Customers").findOne({
    pageId: pageIdStr,
    psid: sender_psid,
  });

  const nameFromAi = extractLineValue(orderSummaryText, "Customer Name");
  const phoneFromAi = extractLineValue(orderSummaryText, "Customer Phone");
  const notesFromAi = extractLineValue(orderSummaryText, "Notes");
  const deliveryFromAi = extractLineValue(orderSummaryText, "Delivery Info");
  const itemsFromAi = extractLineValue(orderSummaryText, "Items");
  // const restaurantFromAi = extractLineValue(orderSummaryText, "Restaurant");

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

  console.log("✅ WhatsApp notify result:", notifyResult);

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

    console.log("🧾 Order saved:", String(order._id));
    return { order, notifyResult };
  } catch (e) {
    console.error("⚠️ Order save failed (WhatsApp already sent):", e.message);
    return { order: null, notifyResult };
  }
}

// ===== Messenger message handler =====
router.post("/", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // Respond quickly to Meta
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry || []) {
    const pageIdStr = normalizePageId(entry.id);

    // IMPORTANT: handle ALL messaging events, not just [0]
    for (const webhook_event of entry.messaging || []) {
      const sender_psid = webhook_event?.sender?.id;
      if (!sender_psid) continue;

      try {
        console.log("📩 Event IDs:", {
          entryPageId: pageIdStr,
          senderId: sender_psid,
          recipientId: webhook_event?.recipient?.id,
          isMessage: Boolean(webhook_event?.message),
          isPostback: Boolean(webhook_event?.postback),
        });

        const clientDoc = await getClientDoc(pageIdStr);

        if (clientDoc.active === false) {
          continue; // bot disabled for this page
        }

        // Token sanity check (logs /me id and detects wrong token-page mapping)
        // This helps solve: Graph code 100 subcode 33 on profile fetch
        const tokenCheck = await assertTokenMatchesPage(clientDoc.PAGE_ACCESS_TOKEN, pageIdStr);
        if (!tokenCheck.ok) {
          // Don't crash; just continue without name fetching
          console.warn("⚠️ Token check not ok:", tokenCheck.reason);
        }

        // ===== Attachments =====
        if (webhook_event.message?.attachments?.length > 0) {
          await sendMessengerReply(
            sender_psid,
            "Could you describe what's in the image, or say the name of the item you are looking for so I can help you better?",
            pageIdStr
          );
          continue;
        }

        // ===== Text message =====
        if (webhook_event.message?.text) {
          const userMessage = webhook_event.message.text;
          const db = await connectDB();

          const getFreshConvo = async () =>
            db.collection("Conversations").findOne({
              pageId: pageIdStr, // ✅ normalized
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

            console.log("🤖 Bot auto-resumed (timer)");
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

            await sendMessengerReply(sender_psid, "✅ Bot is reactivated!", pageIdStr);
            continue;
          }

          // If human escalation active → ignore bot AI reply
          if (convoCheck?.humanEscalation === true) {
            continue;
          }

          async function processMessage() {
            let convo, history, greeting, firstName;

            const finalSystemPrompt = await SYSTEM_PROMPT({ pageId: pageIdStr });
            convo = await getConversation(pageIdStr, sender_psid);

            history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

            firstName = "there";
            greeting = "";

            // Greeting / name fetch once per day (best effort)
            if (!convo || isNewDay(convo.lastInteraction)) {
              console.log("👤 Fetching user profile:", {
                pageId: pageIdStr,
                psid: sender_psid,
                hasPageToken: Boolean(clientDoc.PAGE_ACCESS_TOKEN),
              });

              let userProfile = { first_name: "there" };

              // Only try profile fetch if tokenCheck ok
              if (tokenCheck.ok) {
                userProfile = await getUserProfile(sender_psid, clientDoc.PAGE_ACCESS_TOKEN);
              }

              firstName = userProfile.first_name || "there";
              await saveCustomer(pageIdStr, sender_psid, userProfile);

              greeting = `Hi ${firstName}, good to see you today 👋`;
              history.push({ role: "assistant", content: greeting, createdAt: new Date() });
            }

            history.push({ role: "user", content: userMessage, createdAt: new Date() });

            // Count ONLY when we actually use the bot (OpenAI call)
            const usage = await incrementMessageCount(pageIdStr);
            if (!usage.allowed) {
              await sendMessengerReply(sender_psid, "⚠️ Message limit reached.", pageIdStr);
              return;
            }

            // Generate AI reply
            let assistantMessage;
            try {
              assistantMessage = await getChatCompletion(history);
            } catch (err) {
              console.error("❌ OpenAI error:", err.message);

              await db.collection("Logs").insertOne({
                pageId: pageIdStr,
                psid: sender_psid,
                level: "error",
                source: "openai",
                message: err.message,
                timestamp: new Date(),
              });

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

              await sendMessengerReply(
                sender_psid,
                "👤 A human agent will take over shortly.\nYou can type !bot anytime to return to the assistant.\n\nسيقوم أحد موظفي الدعم بالرد عليك قريبًا.",
                pageIdStr
              );
              return;
            }

            // ORDER REQUEST
            if (flags.order) {
              await db.collection("Conversations").updateOne(
                { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
                { $inc: { orderRequestCount: 1 } },
                { upsert: true }
              );

              try {
                await createOrderFlow({
                  pageId: pageIdStr,
                  sender_psid,
                  orderSummaryText: assistantMessage,
                  channel: "messenger",
                });

                await sendMessengerReply(
                  sender_psid,
                  "✅ Your order request has been received.\nA staff member will contact you shortly.\n\nتم استلام طلبك وسيتم التواصل معك قريبًا.",
                  pageIdStr
                );
              } catch (err) {
                console.error("❌ Order flow failed:", err.message);
                await sendMessengerReply(
                  sender_psid,
                  "⚠️ We couldn't process your order right now. Please try again.",
                  pageIdStr
                );
              }
              return;
            }

            if (flags.tour) {
              await db.collection("Conversations").updateOne(
                { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
                { $inc: { tourRequestCount: 1 } },
                { upsert: true }
              );
            }

            // Save conversation
            history.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
            await saveConversation(pageIdStr, sender_psid, history, new Date());

            const combinedMessage = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;

            // Send reply
            await sendMessengerReply(sender_psid, combinedMessage, pageIdStr);
          }

          // Mark as read + process
          await sendMarkAsRead(sender_psid, pageIdStr);

          // Small delay to feel natural
          await new Promise((resolve) => setTimeout(resolve, 800));

          await processMessage().catch(async (err) => {
            console.error("❌ Processing error:", err.message);

            await db.collection("Logs").insertOne({
              pageId: pageIdStr,
              psid: sender_psid,
              level: "error",
              source: "messenger",
              message: err.message,
              timestamp: new Date(),
            });

            await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", pageIdStr);
          });

          continue;
        }

        // ===== Postbacks (ice breakers) =====
        if (webhook_event.postback?.payload) {
          const payload = webhook_event.postback.payload;
          const responses = {
            ICE_BREAKER_PROPERTIES: "Sure! What type of property are you looking for and in which area?",
            ICE_BREAKER_BOOK: "You can book a visit by telling me the property you're interested in.",
            ICE_BREAKER_PAYMENT: "Yes! We offer several payment plans. What’s your budget or preferred duration?",
          };

          if (responses[payload]) {
            await sendMarkAsRead(sender_psid, pageIdStr);
            await sendMessengerReply(sender_psid, responses[payload], pageIdStr);
          }
        }
      } catch (error) {
        console.error("❌ Messenger error:", error?.message || error);
        try {
          await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", pageIdStr);
        } catch {
          // ignore
        }
      }
    }
  }
});

export default router;
