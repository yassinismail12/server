// services/instagram.js
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

async function connectDB() {
  if (!mongoClient.topology?.isConnected()) {
    console.log("🔗 Connecting to MongoDB (IG service)...");
    await mongoClient.connect();
    console.log("✅ MongoDB connected (IG service)");
  }
  return mongoClient.db(dbName);
}

function normalizeIgId(id) {
  return id.toString().trim();
}

// ✅ Strong sanitize: remove Bearer, quotes, AND ALL whitespace anywhere in token
function sanitizeAccessToken(token) {
  return String(token || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^"|"$/g, "")
    .replace(/\s+/g, "") // ✅ removes hidden newlines/tabs inside the token
    .trim();
}

function tokenPreview(t) {
  if (!t) return "(empty)";
  return `${t.slice(0, 10)}...${t.slice(-6)}`;
}

/**
 * Send an Instagram DM reply
 * @param {string} psid - Instagram user PSID
 * @param {string} text - Message text
 * @param {string} igId - Instagram business account ID (entry.id)
 * @param {string} [igAccessTokenOverride] - optional token passed from caller (preferred)
 */
export async function sendInstagramReply(psid, text, igId, igAccessTokenOverride = null) {
  try {
    const igIdStr = normalizeIgId(igId);

    // ✅ Prefer token passed from caller
    let token = sanitizeAccessToken(igAccessTokenOverride);

    // Fallback to DB if not passed
    if (!token) {
      const db = await connectDB();
      const clients = db.collection("Clients");
      const clientDoc = await clients.findOne({ igId: igIdStr });

      if (!clientDoc?.igAccessToken) {
        console.error("❌ Missing IG client or igAccessToken for igId:", igIdStr);
        return;
      }

      token = sanitizeAccessToken(clientDoc.igAccessToken);
    }

    // ✅ Safe logs to catch whitespace / wrong token quickly
    console.log("🔑 IG token length:", token.length);
    console.log("🔑 IG token preview:", tokenPreview(token));
    console.log("🔑 IG token has whitespace?:", /\s/.test(String(igAccessTokenOverride || "")));

    if (!token || token.length < 60) {
      console.error("❌ Invalid IG access token (empty/too short). Cannot send IG message.");
      return;
    }

    // ✅ Use Authorization header (cleaner) + still include access_token as query for compatibility
    const url = `https://graph.facebook.com/v21.0/${igIdStr}/messages?access_token=${encodeURIComponent(token)}`;

    const payload = {
      recipient: { id: psid },
      message: { text },
    };

    console.log(`📤 Sending IG reply to ${psid}:`, text);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`, // ✅ helps in some cases
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("❌ Failed to send IG message:", data);
    } else {
      console.log("✅ IG message sent successfully:", data);
    }
  } catch (error) {
    console.error("❌ sendInstagramReply error:", error);
  }
}
