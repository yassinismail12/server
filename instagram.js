// instagram.js
import express from "express";
import fetch from "node-fetch";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendInstagramReply } from "./services/instagram.js"; // ✅ Create this like messenger.js
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";

const router = express.Router();
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== Helper to normalize igId =====
function normalizeIgId(id) {
  return id.toString().trim();
}

// ✅ Helper to sanitize tokens (prevents "Cannot parse access token")
function sanitizeAccessToken(token) {
  return String(token || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^"|"$/g, "");
}

// ✅ Helper: validate token quickly
function isLikelyValidToken(token) {
  const t = sanitizeAccessToken(token);
  // Meta tokens are long and usually start with EAA (not always, but good heuristic)
  return t.length >= 60;
}

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
async function getClientDoc(igId) {
  const db = await connectDB();
  const clients = db.collection("Clients");

  const igIdStr = normalizeIgId(igId);

  console.log(`🔍 Fetching client document for igId: ${igIdStr}`);
  let client = await clients.findOne({ igId: igIdStr });

  if (!client) {
    console.log("⚠️ Client not found, creating new one");
    client = {
      igId: igIdStr,
      messageCount: 0,
      messageLimit: 1000,
      active: true,
      VERIFY_TOKEN: null,
      igAccessToken: null,
      quotaWarningSent: false,
    };
    await clients.insertOne(client);
  }

  return client;
}

async function incrementMessageCount(igId) {
  const db = await connectDB();
  const clients = db.collection("Clients");

  const igIdStr = normalizeIgId(igId);

  console.log(`➕ Incrementing message count for igId: ${igIdStr}`);

  const updated = await clients.findOneAndUpdate(
    { igId: igIdStr },
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
      returnDocument: "after",
    }
  );

  const doc = updated.value || (await clients.findOne({ igId: igIdStr }));

  if (!doc) {
    console.error("❌ Still could not find or create client");
    throw new Error(`Failed to increment or create client for igId: ${igIdStr}`);
  }

  if (doc.messageCount > doc.messageLimit) {
    console.log("❌ Message limit reached");
    return { allowed: false, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
  }

  const remaining = doc.messageLimit - doc.messageCount;

  if (remaining === 100 && !doc.quotaWarningSent) {
    console.log("⚠️ Only 100 messages left, sending quota warning");
    await sendQuotaWarning(igIdStr);
    await clients.updateOne({ igId: igIdStr }, { $set: { quotaWarningSent: true } });
  }

  return { allowed: true, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
}

// ===== Conversation =====
async function getConversation(igId, userId) {
  const db = await connectDB();
  const igIdStr = normalizeIgId(igId);
  console.log(`💬 Fetching conversation for igId: ${igIdStr}, userId: ${userId}`);
  return await db.collection("Conversations").findOne({ igId: igIdStr, userId });
}

async function saveConversation(igId, userId, history, lastInteraction) {
  const db = await connectDB();
  const igIdStr = normalizeIgId(igId);
  console.log(`💾 Saving conversation for igId: ${igIdStr}, userId: ${userId}`);
  await db.collection("Conversations").updateOne(
    { igId: igIdStr, userId, source: "instagram" },
    { $set: { history, lastInteraction, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function saveCustomer(igId, psid, userProfile) {
  const db = await connectDB();
  const igIdStr = normalizeIgId(igId);
  const fullName = `${userProfile.username || ""}`.trim();
  console.log(`💾 Saving customer ${fullName} for igId: ${igIdStr}`);
  await db.collection("Customers").updateOne(
    { igId: igIdStr, psid },
    {
      $set: {
        igId: igIdStr,
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
async function getUserProfile(psid, igAccessToken) {
  const token = sanitizeAccessToken(igAccessToken);
  console.log(`🔍 Fetching IG user profile for PSID: ${psid}`);

  if (!isLikelyValidToken(token)) {
    console.warn("⚠️ IG access token missing/invalid while fetching profile, using fallback name 'there'");
    return { username: "there" };
  }

  const url = `https://graph.facebook.com/${psid}?fields=username&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.warn("⚠️ Failed to fetch IG user profile, using fallback name 'there'");
    return { username: "there" };
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
  console.log("🔑 IG Webhook verification request received");

  if (!mode || !token) {
    console.warn("❌ Mode or token missing");
    return res.sendStatus(403);
  }

  const db = await connectDB();
  const client = await db.collection("Clients").findOne({ VERIFY_TOKEN: token });

  if (mode === "subscribe" && client) {
    console.log("✅ IG Webhook verified successfully");
    res.status(200).send(challenge);
  } else {
    console.warn("❌ IG Webhook verification failed");
    res.sendStatus(403);
  }
});

// ===== Instagram message handler =====
router.post("/", async (req, res) => {
  const body = req.body;
  console.log("📩 IG POST received", JSON.stringify(body));

  if (body.object !== "instagram") {
    console.warn("❌ Body object is not instagram");
    return res.sendStatus(404);
  }

  for (const entry of body.entry) {
    const igId = normalizeIgId(entry.id);

    // 👇 Loop through all messaging events
    for (const messaging of entry.messaging || []) {
      const sender_psid = messaging?.sender?.id;
      console.log(`📬 Event from igId: ${igId}, sender_psid: ${sender_psid}`);

      // track these for catch block fallback
      let clientDoc = null;
      let token = "";

      try {
        clientDoc = await getClientDoc(igId);
        token = sanitizeAccessToken(clientDoc?.igAccessToken);

        // ✅ Token sanity logs (safe)
        console.log("🔑 IG token length:", token.length);
        console.log("🔑 IG token preview:", token ? `${token.slice(0, 10)}...${token.slice(-6)}` : "(empty)");

        if (!isLikelyValidToken(token)) {
          console.warn("❌ IG access token missing/invalid for this client. Cannot send IG replies.");
          const db = await connectDB();
          await db.collection("Logs").insertOne({
            igId,
            userId: sender_psid,
            source: "instagram",
            level: "error",
            message: "Missing/invalid igAccessToken (cannot parse / too short).",
            timestamp: new Date(),
          });
          continue; // don't try to reply with a broken token
        }

        if (clientDoc.active === false) {
          console.log("⚠️ Bot inactive for this page");
          // passing token as extra arg is harmless if sendInstagramReply ignores it
          await sendInstagramReply(sender_psid, "⚠️ This bot is currently disabled.", igId, token);
          continue;
        }

        const usage = await incrementMessageCount(igId);
        if (!usage.allowed) {
          console.log("⚠️ Message limit reached, not sending reply");
          await sendInstagramReply(sender_psid, "⚠️ Message limit reached.", igId, token);
          continue;
        }

        if (messaging?.message?.text) {
          const userMessage = messaging.message.text;
          console.log("📝 Received IG user message:", userMessage);

          const finalSystemPrompt = await SYSTEM_PROMPT({ igId });
          let convo = await getConversation(igId, sender_psid);
          let history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

          let firstName = "there";
          let greeting = "";

          if (!convo || isNewDay(convo?.lastInteraction)) {
            const userProfile = await getUserProfile(sender_psid, token);

            firstName = userProfile.username || "there";
            await saveCustomer(igId, sender_psid, userProfile);

            greeting = `Hi ${firstName}, good to see you today 👋`;
            history.push({ role: "assistant", content: greeting, createdAt: new Date() });
          }

          history.push({ role: "user", content: userMessage, createdAt: new Date() });

          let assistantMessage;
          try {
            assistantMessage = await getChatCompletion(history);
          } catch (err) {
            console.error("❌ OpenAI error:", err.message);
            const db = await connectDB();
            await db.collection("Logs").insertOne({
              igId,
              userId: sender_psid,
              source: "openai",
              level: "error",
              message: err.message,
              timestamp: new Date(),
            });
            assistantMessage = "⚠️ Sorry, I’m having trouble. Please try again later.";
          }

          console.log("🤖 Assistant message:", assistantMessage);

          history.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });
          await saveConversation(igId, sender_psid, history, new Date());

          let combinedMessage = assistantMessage;
          if (greeting) combinedMessage = `${greeting}\n\n${assistantMessage}`;

          if (assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            data.igId = igId;
            console.log("✈️ Tour request detected, sending email", data);
            try {
              await sendTourEmail(data);
            } catch (err) {
              console.error("❌ Failed to send tour email:", err.message);
              const db = await connectDB();
              await db.collection("Logs").insertOne({
                igId,
                userId: sender_psid,
                source: "email",
                level: "error",
                message: err.message,
                timestamp: new Date(),
              });
            }
          }

          await sendInstagramReply(sender_psid, combinedMessage, igId, token);
        }
      } catch (error) {
        console.error("❌ Instagram error:", error.message);
        try {
          const db = await connectDB();
          await db.collection("Logs").insertOne({
            igId,
            userId: sender_psid,
            source: "instagram",
            level: "error",
            message: error.message,
            timestamp: new Date(),
          });
        } catch (dbErr) {
          console.error("❌ Failed to log IG error:", dbErr.message);
        }

        // ✅ Only try to send fallback if token looks valid
        try {
          if (isLikelyValidToken(token)) {
            await sendInstagramReply(sender_psid, "⚠️ حصلت مشكلة. جرب تاني بعد شوية.", igId, token);
          } else {
            console.warn("⚠️ Skipping fallback IG reply because token is missing/invalid.");
          }
        } catch (sendErr) {
          console.error("❌ Failed to send fallback IG reply:", sendErr.message);
        }
      }
    }
  }

  // ✅ Respond once after processing all entries
  res.status(200).send("EVENT_RECEIVED");
});

export default router;
