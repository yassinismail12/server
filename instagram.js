// instagram.js (FIXED v2 - Dedupe fixed properly)
// ✅ Skip echo events
// ✅ Only dedupe INBOUND USER TEXT messages
// ✅ Dedupe key = (igBusinessId, mid)
// ✅ Add env toggle: DEDUPE_ENABLED=true/false
// ✅ Correct IG send endpoint: POST /{PAGE_ID}/messages

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

const DEDUPE_ENABLED = String(process.env.DEDUPE_ENABLED || "true").toLowerCase() === "true";

// ===============================
// Helpers
// ===============================
function normalizeId(id) {
  return String(id || "").trim();
}

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

// Only treat actual user inbound text as a "chat message"
// This prevents dedupe from firing on weird non-text events, delivery events, etc.
function isInboundUserText({ igBusinessId, messaging }) {
  const msg = messaging?.message;
  if (!msg?.text) return false;                  // must be a text message
  if (msg?.is_echo) return false;                // not echo
  const senderId = normalizeId(messaging?.sender?.id);
  if (!senderId) return false;
  // If sender is the IG business itself, it's not a user inbound chat
  if (senderId === normalizeId(igBusinessId)) return false;
  return true;
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
// Client Resolution
// ===============================
async function getClientDocByIgBusinessId(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igIdStr = normalizeId(igBusinessId);

  const client =
    (await clients.findOne({ igBusinessId: igIdStr })) ||
    (await clients.findOne({ igId: igIdStr })); // legacy

  if (!client) return null;

  const pageId =
    normalizeId(client.pageId) ||
    normalizeId(client.PAGE_ID) ||
    normalizeId(client.page_id);

  const pageAccessToken =
    sanitizeAccessToken(
      client.pageAccessToken ||
        client.PAGE_ACCESS_TOKEN ||
        client.page_token ||
        client.pageToken ||
        client.PAGE_TOKEN
    ) || "";

  return {
    ...client,
    igBusinessId: igIdStr,
    resolvedPageId: pageId,
    resolvedPageAccessToken: pageAccessToken,
  };
}

// ===============================
// Message limits
// ===============================
async function incrementMessageCount(igBusinessId) {
  const db = await connectDB();
  const clients = db.collection("Clients");
  const igIdStr = normalizeId(igBusinessId);

  const filter = { $or: [{ igBusinessId: igIdStr }, { igId: igIdStr }] };

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
      { upsert: true, returnDocument: "after" }
    );
  } catch (e) {
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
      { upsert: true, returnOriginal: false }
    );
  }

  const doc = updated?.value || (await clients.findOne(filter));
  if (!doc) throw new Error(`Failed to increment message count for igBusinessId=${igIdStr}`);

  if (doc.messageCount > doc.messageLimit) {
    return { allowed: false, messageCount: doc.messageCount, messageLimit: doc.messageLimit };
  }

  const remaining = doc.messageLimit - doc.messageCount;

  // you had 950 here; normally you warn at 100 remaining.
  // Keeping your logic but feel free to change:
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

// IG user profile (best effort)
async function getUserProfile(igUserId, pageAccessToken) {
  const token = sanitizeAccessToken(pageAccessToken);
  if (!isLikelyValidToken(token)) return { username: "there" };

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
// Dedupe (fixed)
// ===============================
// IMPORTANT: You need a unique index on { igBusinessId: 1, mid: 1 } in ProcessedEvents
async function dedupeOrSkip({ igBusinessId, mid, senderId }) {
  if (!DEDUPE_ENABLED) return false;
  if (!mid) return false;

  const db = await connectDB();
  const processed = db.collection("ProcessedEvents");

  const doc = {
    igBusinessId: normalizeId(igBusinessId),
    mid: normalizeId(mid),
    senderId: normalizeId(senderId),
    createdAt: new Date(),
  };

  try {
    await processed.insertOne(doc);
    return false; // not duplicate
  } catch (e) {
    // Only treat DUPLICATE KEY as duplicate
    if (e?.code === 11000 || e?.codeName === "DuplicateKey") {
      console.log("🔁 Duplicate inbound user message, skipping", { igBusinessId: doc.igBusinessId, mid: doc.mid });
      return true;
    }
    console.error("❌ ProcessedEvents insert failed (NOT duplicate):", e?.message || e);
    throw e;
  }
}

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

  if (mode === "subscribe" && client) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===============================
// Correct hard-coded IG send test
// ===============================
router.get("/ig-test-send", async (req, res) => {
  const pageId = normalizeId(req.query.pageId || process.env.PAGE_ID);
  const pageToken = sanitizeAccessToken(req.query.pageToken || process.env.PAGE_ACCESS_TOKEN);
  const recipientId = normalizeId(req.query.recipientId);
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

  res.status(200).send("EVENT_RECEIVED");
  if (body.object !== "instagram") return;

  (async () => {
    const db = await connectDB();

    for (const entry of body.entry || []) {
      const igBusinessId = normalizeId(entry.id);

      for (const messaging of entry.messaging || []) {
        const mid = messaging?.message?.mid;
        const isEcho = !!messaging?.message?.is_echo;
        const senderId = normalizeId(messaging?.sender?.id);
        const recipientId = normalizeId(messaging?.recipient?.id);

        console.log(`📬 [${nowIso()}] IG event`, JSON.stringify({ igBusinessId, senderId, recipientId, mid, isEcho }));

        // 1) Skip echo always
        if (isEcho) {
          console.log("↩️ Echo event, skipping", { igBusinessId, mid });
          continue;
        }

        // 2) Only process inbound user text messages as chat
        const inboundUserText = isInboundUserText({ igBusinessId, messaging });
        const userText = messaging?.message?.text;

        if (!inboundUserText) {
          // Not a chat message we want to reply to (prevents dedupe + processing on weird events)
          continue;
        }

        // 3) Dedupe ONLY on inbound user text
        if (await dedupeOrSkip({ igBusinessId, mid, senderId })) continue;

        // 4) Resolve client
        const clientDoc = await getClientDocByIgBusinessId(igBusinessId);
        if (!clientDoc) {
          console.warn("❌ No client mapping for this igBusinessId.", { igBusinessId });
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
        console.log("🔑 pageToken preview:", pageToken ? `${pageToken.slice(0, 10)}...${pageToken.slice(-6)}` : "(empty)");

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
          await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId: senderId, text: "⚠️ This bot is currently disabled." });
          continue;
        }

        // Quota
        const usage = await incrementMessageCount(igBusinessId);
        if (!usage.allowed) {
          await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId: senderId, text: "⚠️ Message limit reached." });
          continue;
        }

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

        if (greeting) history.push({ role: "assistant", content: greeting, createdAt: new Date() });
        history.push({ role: "user", content: userText, createdAt: new Date() });

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
        await saveConversation(igBusinessId, senderId, history, new Date(), clientDoc.clientId);

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

        try {
          await sendInstagramDM({ pageId, pageAccessToken: pageToken, recipientId: senderId, text: finalReply });
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
