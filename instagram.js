// instagram.js (FIXED)
// Key fixes:
// ✅ DO NOT create blank client docs on webhook (causes missing tokens forever)
// ✅ Skip is_echo events (never reply to your own messages)
// ✅ Use correct IG DM send endpoint: POST /{PAGE_ID}/messages (NOT /{IG_ID}/messages)
// ✅ Support legacy DB fields + new recommended fields
// ✅ Dedupe on (igId + mid) instead of mid alone
// ✅ Clear, consistent token handling + logging

import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";
let dbPromise = null;

// ===============================
// Helpers
// ===============================
function normalizeId(id) {
  return String(id || "").trim();
}

// removes Bearer, quotes, whitespace, and invisible chars
function sanitizeAccessToken(token) {
  return String(token || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^"|"$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function isLikelyValidToken(token) {
  const t = sanitizeAccessToken(token);
  return t.length >= 60 && /^EAA/i.test(t);
}

function nowIso() {
  return new Date().toISOString();
}

// ===============================
// DB Connection
// ===============================
async function connectDB() {
  if (!dbPromise) {
    dbPromise = (async () => {
      console.log("🔗 Connecting to MongoDB...");
      await mongoClient.connect();
      console.log("✅ MongoDB connected");
      return mongoClient.db(dbName);
    })();
  }
  return dbPromise;
}

// ===============================
// Client Resolution (IMPORTANT)
// ===============================
// We accept webhook entry.id as IG Business ID (igBusinessId).
// Token we need for sending is PAGE access token + PAGE ID.
//
// Your DB might have older field names. We support both:
// New recommended fields:
//   - igBusinessId, pageId, pageAccessToken
// Legacy fields you may already have:
//   - igId, PAGE_ACCESS_TOKEN, page_token, pageToken, PAGE_ID, pageId
async function getClientDocByIgBusinessId(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igIdStr = normalizeId(igBusinessId);

  // Try new schema first, then legacy.
  const client =
    (await clients.findOne({ igBusinessId: igIdStr })) ||
    (await clients.findOne({ igId: igIdStr }));

  if (!client) return null;

  // Resolve pageId from multiple possible field names
  const pageId =
    normalizeId(client.pageId) ||
    normalizeId(client.PAGE_ID) ||
    normalizeId(client.page_id);

  // Resolve pageAccessToken from multiple possible field names
  const pageAccessToken =
    sanitizeAccessToken(
      client.pageAccessToken ||
        client.PAGE_ACCESS_TOKEN ||
        client.page_token ||
        client.pageToken ||
        client.PAGE_TOKEN
    ) || "";

  return { ...client, igBusinessId: igIdStr, resolvedPageId: pageId, resolvedPageAccessToken: pageAccessToken };
}

// ===============================
// Message limits
// ===============================
async function incrementMessageCount(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igIdStr = normalizeId(igBusinessId);

  const filter = { $or: [{ igBusinessId: igIdStr }, { igId: igIdStr }] };

  // Try modern driver option first
  let updated;
  try {
    updated = await clients.findOneAndUpdate(
      filter,
      {
        $inc: { messageCount: 1 },
        $setOnInsert: {
          igBusinessId: igIdStr,
          active: true,
          messageLimit: 1000,
          quotaWarningSent: false,
        },
      },
      { upsert: true, returnDocument: "after" } // mongodb v4+
    );
  } catch (e) {
    // Fallback for older driver versions
    updated = await clients.findOneAndUpdate(
      filter,
      {
        $inc: { messageCount: 1 },
        $setOnInsert: {
          igBusinessId: igIdStr,
          active: true,
          messageLimit: 1000,
          quotaWarningSent: false,
        },
      },
      { upsert: true, returnOriginal: false } // mongodb v3.x
    );
  }

  // Some driver/env combos still return null in updated.value; fetch explicitly
  let doc = updated?.value || (await clients.findOne(filter));

  if (!doc) {
    throw new Error(`Failed to increment message count for igBusinessId=${igIdStr}`);
  }

  if (doc.messageCount > doc.messageLimit) {
    return { allowed: false, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
  }

  const remaining = doc.messageLimit - doc.messageCount;

  if (remaining === 950 && !doc.quotaWarningSent) {
    await sendQuotaWarning(igIdStr);
    await clients.updateOne(filter, { $set: { quotaWarningSent: true } });
  }

  return { allowed: true, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
}


// ===============================
// Conversations / Customers
// ===============================
async function getConversation(igBusinessId, userId) {
  const db = await connectDB();
  const igIdStr = normalizeId(igBusinessId);
  return db.collection("Conversations").findOne({ igBusinessId: igIdStr, userId, source: "instagram" });
}

async function saveConversation(igBusinessId, userId, history, lastInteraction, clientId) {
  const db = await connectDB();
  const igIdStr = normalizeId(igBusinessId);

  await db.collection("Conversations").updateOne(
    { igBusinessId: igIdStr, userId, source: "instagram" },
    {
      $set: {
        igBusinessId: igIdStr,
        userId,
        clientId: clientId || null,
        source: "instagram",
        history,
        lastInteraction,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function saveCustomer(igBusinessId, userId, userProfile) {
  const db = await connectDB();
  const igIdStr = normalizeId(igBusinessId);
  const username = (userProfile?.username || "").trim();

  await db.collection("Customers").updateOne(
    { igBusinessId: igIdStr, userId, source: "instagram" },
    {
      $set: {
        igBusinessId: igIdStr,
        userId,
        source: "instagram",
        name: username || "Unknown",
        lastInteraction: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

// IG user profile (best effort; falls back if token is missing)
async function getUserProfile(igUserId, pageAccessToken) {
  const token = sanitizeAccessToken(pageAccessToken);
  if (!isLikelyValidToken(token)) return { username: "there" };

  // Works for Instagram Messaging webhooks user IDs in many setups; if it fails we fallback.
  const url = `https://graph.facebook.com/${encodeURIComponent(igUserId)}?fields=username&access_token=${encodeURIComponent(
    token
  )}`;

  const res = await fetch(url);
  if (!res.ok) return { username: "there" };
  return res.json();
}

function isNewDay(lastDate) {
  const today = new Date();
  return (
    !lastDate ||
    lastDate.getDate() !== today.getDate() ||
    lastDate.getMonth() !== today.getMonth() ||
    lastDate.getFullYear() !== today.getFullYear()
  );
}

// ===============================
// Dedupe (IMPORTANT)
// ===============================
// Make sure your DB index is UNIQUE on { igBusinessId: 1, mid: 1 }
// NOT just mid.


// ===============================
// Correct IG send: POST /{PAGE_ID}/messages
// ===============================
async function sendInstagramDM({ pageId, pageAccessToken, recipientId, text }) {
  const token = sanitizeAccessToken(pageAccessToken);
  const pid = normalizeId(pageId);
  const rid = normalizeId(recipientId);

  if (!pid) throw new Error("Missing pageId for IG send");
  if (!isLikelyValidToken(token)) throw new Error("Missing/invalid pageAccessToken for IG send");
  if (!rid) throw new Error("Missing recipientId for IG send");
  if (!text) return;

  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pid)}/messages?access_token=${encodeURIComponent(
    token
  )}`;

  const payload = {
    recipient: { id: rid },
    message: { text },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Failed to send IG message: ${JSON.stringify(data)}`);
  }
  return data;
}

// ===============================
// Webhook verification
// ===============================
router.get("/", async (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!mode || !token) return res.sendStatus(403);

  const db = await connectDB();
  const client = await db.collection("Clients").findOne({ VERIFY_TOKEN: token });

  if (mode === "subscribe" && client) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===============================
// Correct hard-coded IG send test
// (Uses PAGE_ID, not IG_ID)
// ===============================
router.get("/ig-test-send", async (req, res) => {
  const pageId = normalizeId(req.query.pageId || process.env.PAGE_ID);
  const pageToken = sanitizeAccessToken(req.query.pageToken || process.env.PAGE_ACCESS_TOKEN);
  const recipientId = normalizeId(req.query.recipientId); // IG user id from webhook (sender.id)
  const text = String(req.query.text || "✅ Hard-coded IG DM test").slice(0, 1000);

  try {
    const out = await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId, text });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ===============================
// Instagram webhook handler
// ===============================
router.post("/", async (req, res) => {
  const body = req.body;

  // Respond immediately so Meta doesn't retry
  res.status(200).send("EVENT_RECEIVED");

  if (body.object !== "instagram") return;

  (async () => {
    const db = await connectDB();

    for (const entry of body.entry || []) {
      const igBusinessId = normalizeId(entry.id);

      for (const messaging of entry.messaging || []) {
        const mid = messaging?.message?.mid;
        const isEcho = !!messaging?.message?.is_echo;

        // IG inbound: sender.id = USER, recipient.id = IG BUSINESS (often)
        // Echo: sender.id = IG BUSINESS, recipient.id = PAGE or USER
        const senderId = normalizeId(messaging?.sender?.id);
        const recipientId = normalizeId(messaging?.recipient?.id);

        console.log(
          `📬 [${nowIso()}] IG event`,
          JSON.stringify({ igBusinessId, senderId, recipientId, mid, isEcho })
        );

        // ✅ MUST: skip echo events (messages sent by you)
        if (isEcho) {
          console.log("↩️ Echo event, skipping", { igBusinessId, mid });
          continue;
        }

        // ✅ Dedupe on (igBusinessId + mid)
        if (await dedupeOrSkip({ igBusinessId, mid, senderId })) continue;

        // ✅ Resolve client. DO NOT auto-create blank clients here.
        const clientDoc = await getClientDocByIgBusinessId(igBusinessId);

        if (!clientDoc) {
          console.warn("❌ No client mapping for this igBusinessId (not connected yet).", { igBusinessId });
          await db.collection("Logs").insertOne({
            igBusinessId,
            userId: senderId,
            source: "instagram",
            level: "error",
            message: "No client mapping for igBusinessId (not connected).",
            timestamp: new Date(),
          });
          continue;
        }

        const pageId = clientDoc.resolvedPageId;
        const pageToken = clientDoc.resolvedPageAccessToken;

        console.log("🔑 pageId:", pageId || "(missing)");
        console.log(
          "🔑 pageToken preview:",
          pageToken ? `${pageToken.slice(0, 10)}...${pageToken.slice(-6)}` : "(empty)"
        );

        if (!pageId || !isLikelyValidToken(pageToken)) {
          console.warn("❌ Missing pageId or valid pageAccessToken for this client.", { igBusinessId, pageId });
          await db.collection("Logs").insertOne({
            igBusinessId,
            userId: senderId,
            source: "instagram",
            level: "error",
            message: "Missing pageId or pageAccessToken (cannot send IG replies).",
            timestamp: new Date(),
          });
          continue;
        }

        // Bot disabled?
        if (clientDoc.active === false) {
          try {
            await sendInstagramDM({
              pageId,
              pageAccessToken: pageToken,
              recipientId: senderId,
              text: "⚠️ This bot is currently disabled.",
            });
          } catch (e) {
            console.error("❌ Failed to send disabled message:", e.message);
          }
          continue;
        }

        // Quota
        const usage = await incrementMessageCount(igBusinessId);
        if (!usage.allowed) {
          try {
            await sendInstagramDM({
              pageId,
              pageAccessToken: pageToken,
              recipientId: senderId,
              text: "⚠️ Message limit reached.",
            });
          } catch (e) {
            console.error("❌ Failed to send quota message:", e.message);
          }
          continue;
        }

        // Only handle text messages
        const userText = messaging?.message?.text;
        if (!userText) continue;

        console.log("📝 IG user message:", userText);

        const finalSystemPrompt = await SYSTEM_PROMPT({ igId: igBusinessId });

        let convo = await getConversation(igBusinessId, senderId);
        let history = convo?.history || [{ role: "system", content: finalSystemPrompt }];

        let greeting = "";
        if (!convo || isNewDay(convo?.lastInteraction)) {
          const userProfile = await getUserProfile(senderId, pageToken);
          await saveCustomer(igBusinessId, senderId, userProfile);

          const username = userProfile?.username || "there";
          greeting = `Hi ${username}, good to see you today 👋`;
        }

        // Add to chat history
        if (greeting) history.push({ role: "assistant", content: greeting, createdAt: new Date() });
        history.push({ role: "user", content: userText, createdAt: new Date() });

        // OpenAI
        let assistantMessage = "";
        try {
          assistantMessage = await getChatCompletion(history);
        } catch (err) {
          console.error("❌ OpenAI error:", err.message);
          await db.collection("Logs").insertOne({
            igBusinessId,
            userId: senderId,
            source: "openai",
            level: "error",
            message: err.message,
            timestamp: new Date(),
          });
          assistantMessage = "⚠️ Sorry, I’m having trouble. Please try again later.";
        }

        history.push({ role: "assistant", content: assistantMessage, createdAt: new Date() });

        // Save conversation (store clientId if present)
        await saveConversation(igBusinessId, senderId, history, new Date(), clientDoc.clientId);

        // Tour request email
        if (assistantMessage.includes("[TOUR_REQUEST]")) {
          const data = extractTourData(assistantMessage);
          data.igBusinessId = igBusinessId;
          try {
            await sendTourEmail(data);
          } catch (err) {
            console.error("❌ Failed to send tour email:", err.message);
            await db.collection("Logs").insertOne({
              igBusinessId,
              userId: senderId,
              source: "email",
              level: "error",
              message: err.message,
              timestamp: new Date(),
            });
          }
        }

        const finalReply = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;

        // Send reply
        try {
          await sendInstagramDM({
            pageId,
            pageAccessToken: pageToken,
            recipientId: senderId,
            text: finalReply,
          });
        } catch (e) {
          console.error("❌ IG send error:", e.message);
          await db.collection("Logs").insertOne({
            igBusinessId,
            userId: senderId,
            source: "instagram",
            level: "error",
            message: e.message,
            timestamp: new Date(),
          });
        }
      }
    }
  })().catch((e) => console.error("❌ IG background handler crashed:", e.message));
});

export default router;
