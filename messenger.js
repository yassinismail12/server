// messenger.js
import express from "express";
import fetch from "node-fetch";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendMessengerReply, sendMarkAsRead } from "./services/messenger.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { buildStaffAlert } from "./utils/buildStaffAlert.js";
import Order from "./order.js";
import { notifyClientStaffNewOrder } from "./utils/notifyClientStaffWhatsApp.js";

import { MongoClient } from "mongodb";

const router = express.Router();
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== Helper to normalize pageId =====
function normalizePageId(id) {
  return id.toString().trim();
}

// ===== Typing Indicator =====

// ===== DB Connection =====
async function connectDB() {
  if (!mongoClient.topology?.isConnected()) {
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
    {
      upsert: true,
      returnDocument: "after", // MongoDB >= 4.2
    }
  );

  // For some MongoDB versions, the returned value may be under `updated.value` or `updated.lastErrorObject`
  const doc = updated.value || (await clients.findOne({ pageId: pageIdStr }));

  if (!doc) {
    console.error("❌ Still could not find or create client for pageId:", pageIdStr);
    throw new Error(`Failed to increment or create client for pageId: ${pageIdStr}`);
  }

  if (doc.messageCount > doc.messageLimit) {
    console.warn("❌ Message limit reached for pageId:", pageIdStr);
    return {
      allowed: false,
      messageCount: doc.messageCount,
      messageLimit: doc.messageLimit,
    };
  }

  const remaining = doc.messageLimit - doc.messageCount;

  if (remaining === 100 && !doc.quotaWarningSent) {
    console.warn("⚠️ Only 100 messages left for pageId:", pageIdStr);
    await sendQuotaWarning(pageIdStr);
    await clients.updateOne(
      { pageId: pageIdStr },
      { $set: { quotaWarningSent: true } }
    );
  }

  return {
    allowed: true,
    messageCount: doc.messageCount,
    messageLimit: doc.messageLimit,
  };
}

// ===== Conversation =====
async function getConversation(pageId, userId) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);
  return await db.collection("Conversations").findOne({ pageId: pageIdStr, userId });
}

async function saveConversation(pageId, userId, history, lastInteraction) {
  const db = await connectDB();
  const pageIdStr = normalizePageId(pageId);

  // 🔍 Lookup the client that owns this Messenger pageId
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

// ===== Users =====
async function getUserProfile(psid, pageAccessToken) {
  const url = `https://graph.facebook.com/${psid}?fields=first_name,last_name&access_token=${pageAccessToken}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { first_name: "there" };
  }
  return res.json();
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
async function createOrderFlow({
  pageId,
  sender_psid,
  userMessage,
  channel = "messenger",
}) {
  const db = await connectDB();

  // 1) Find client
  const client = await db.collection("Clients").findOne({ pageId });
  if (!client) throw new Error("Client not found");

  // 2) Find customer (optional data)
  const customer = await db.collection("Customers").findOne({
    pageId,
    psid: sender_psid,
  });

  const customerName = customer?.name || "Unknown";
  const customerPhone = customer?.phone || "";

  // 3) Create order
  const order = await Order.create({
    clientId: client._id,
    channel,
    customer: {
      name: customerName,
      phone: customerPhone,
      externalUserId: sender_psid,
    },
    itemsText: userMessage,
    notes: "Order requested via chat",
    status: "new",
  });

  // 4) Notify staff on WhatsApp (Cloud API)
  await notifyClientStaffNewOrder({
    clientId: client._id,
    payload: {
      customerName,
      customerPhone,
      itemsText: userMessage,
      notes: "Requested via Messenger",
      orderId: String(order._id),
    },
  });

  return order;
}

// ===== Messenger message handler =====
router.post("/", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  for (const entry of body.entry) {
    const pageId = normalizePageId(entry.id);
    const webhook_event = entry.messaging[0];
    const sender_psid = webhook_event.sender.id;

    try {
      const clientDoc = await getClientDoc(pageId);

      if (clientDoc.active === false) {
        // bot disabled for this page
        continue;
      }

      // ===== Image / Attachment Handler =====
      if (webhook_event.message?.attachments?.length > 0) {
        await sendMessengerReply(
          sender_psid,
          "Could you describe what's in the image, or say the name of the item u are looking for so I can help you better?",
          pageId
        );
        continue;
      }

      if (webhook_event.message?.text) {
        const userMessage = webhook_event.message.text;
        const db = await connectDB();

        // Fetch existing conversation to check if human escalation is active
        const getFreshConvo = async () =>
          db.collection("Conversations").findOne({
            pageId,
            userId: sender_psid,
            source: "messenger",
          });

        let convoCheck = await getFreshConvo();

        // ⏱ Auto-resume bot if timer expired
        if (
          convoCheck?.humanEscalation === true &&
          convoCheck?.botResumeAt &&
          new Date() >= new Date(convoCheck.botResumeAt)
        ) {
          await db.collection("Conversations").updateOne(
            { pageId, userId: sender_psid, source: "messenger" },
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

        // --- Resume bot command (customer) ---
        if (userMessage.trim().toLowerCase() === "!bot") {
          await db.collection("Conversations").updateOne(
            { pageId, userId: sender_psid, source: "messenger" },
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
          continue; // command handled; skip AI
        }

        // --- If human escalation active → ignore bot AI reply ---
        if (convoCheck?.humanEscalation === true) {
          continue;
        }

        // ===== Robust Typing Handler =====
        async function processMessageWithTyping() {
          let convo, history, greeting, firstName;

          // ===== AI + DB work =====
          const finalSystemPrompt = await SYSTEM_PROMPT({ pageId });
          convo = await getConversation(pageId, sender_psid);
          history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

          firstName = "there";
          greeting = "";

          if (!convo || isNewDay(convo.lastInteraction)) {
            const userProfile = await getUserProfile(
              sender_psid,
              clientDoc.PAGE_ACCESS_TOKEN
            );
            firstName = userProfile.first_name || "there";
            await saveCustomer(pageId, sender_psid, userProfile);

            greeting = `Hi ${firstName}, good to see you today 👋`;
            history.push({
              role: "assistant",
              content: greeting,
              createdAt: new Date(),
            });
          }

          history.push({ role: "user", content: userMessage, createdAt: new Date() });

          // ✅ Count ONLY when we actually use the bot (OpenAI call)
          const usage = await incrementMessageCount(pageId);
          if (!usage.allowed) {
            await sendMessengerReply(sender_psid, "⚠️ Message limit reached.", pageId);
            return;
          }

          // ===== Generate AI reply =====
          let assistantMessage;
          try {
            assistantMessage = await getChatCompletion(history);
          } catch (err) {
            console.error("❌ OpenAI error:", err.message);

            const db = await connectDB();
            await db.collection("Logs").insertOne({
              pageId,
              psid: sender_psid,
              level: "error",
              source: "openai",
              message: err.message,
              timestamp: new Date(),
            });

            assistantMessage =
              "⚠️ I'm having trouble right now. Please try again shortly.";
          }

          // ===== CONTROL TOKENS PARSING (FIX) =====
          const flags = {
            human: false,
            tour: false,
            order: false,
          };

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

          const db = await connectDB();

          // ===== Human escalation =====
          if (flags.human) {
            const botResumeAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // auto-unmute fallback

            await db.collection("Conversations").updateOne(
              { pageId, userId: sender_psid, source: "messenger" },
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

            console.warn("👤 Human escalation triggered:", { pageId, psid: sender_psid });


            await sendMessengerReply(
              sender_psid,
              "👤 A human agent will take over shortly.\nYou can type !bot anytime to return to the assistant.\n\nسيقوم أحد موظفي الدعم بالرد عليك قريبًا.",
              pageId
            );

            return;
          }

          // ===== Analytics counters =====
       // ===== ORDER REQUEST HANDLING =====
if (flags.order) {
  // analytics
  await db.collection("Conversations").updateOne(
    { pageId, userId: sender_psid, source: "messenger" },
    { $inc: { orderRequestCount: 1 } },
    { upsert: true }
  );

  try {
    await createOrderFlow({
      pageId,
      sender_psid,
      userMessage,
      channel: "messenger",
    });

    // acknowledge customer
    await sendMessengerReply(
      sender_psid,
      "✅ Your order request has been received.\nA staff member will contact you shortly.\n\nتم استلام طلبك وسيتم التواصل معك قريبًا.",
      pageId
    );

    return; // stop normal bot reply
  } catch (err) {
    console.error("❌ Order flow failed:", err.message);

    await sendMessengerReply(
      sender_psid,
      "⚠️ We couldn't process your order right now. Please try again.",
      pageId
    );

    return;
  }
}


          if (flags.tour) {
            await db.collection("Conversations").updateOne(
              { pageId, userId: sender_psid, source: "messenger" },
              { $inc: { tourRequestCount: 1 } },
              { upsert: true }
            );
          }

          // ===== Save conversation (CLEAN) =====
          history.push({
            role: "assistant",
            content: assistantMessage,
            createdAt: new Date(),
          });
          await saveConversation(pageId, sender_psid, history, new Date());

          let combinedMessage = assistantMessage;
          if (greeting) combinedMessage = `${greeting}\n\n${assistantMessage}`;

          // ===== Send reply =====
          await sendMessengerReply(sender_psid, combinedMessage, pageId);
        }

        // ===== Show mark_seen while processing =====
        await sendMarkAsRead(sender_psid, pageId);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await processMessageWithTyping().catch(async (err) => {
          console.error("❌ Processing error:", err.message);

          const db = await connectDB();
          await db.collection("Logs").insertOne({
            pageId,
            psid: sender_psid,
            level: "error",
            source: "messenger",
            message: err.message,
            timestamp: new Date(),
          });

          await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", pageId);
        });
      }

      if (webhook_event.postback?.payload) {
        const payload = webhook_event.postback.payload;
        const responses = {
          ICE_BREAKER_PROPERTIES:
            "Sure! What type of property are you looking for and in which area?", 
          ICE_BREAKER_BOOK:
            "You can book a visit by telling me the property you're interested in.",
          ICE_BREAKER_PAYMENT:
            "Yes! We offer several payment plans. What’s your budget or preferred duration?",
        };
        if (responses[payload]) {
          await sendMarkAsRead(sender_psid, pageId);
          await sendMessengerReply(sender_psid, responses[payload], pageId);
        }
      }
    } catch (error) {
      console.error("❌ Messenger error:", error);
      try {
        await sendMessengerReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", pageId);
      } catch (e) {
        // avoid crashing if send fails
      }
    }
  }

  res.status(200).send("EVENT_RECEIVED");
});

export default router;
