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

// ✅ Prevent "Cannot parse access token"
function sanitizeAccessToken(token) {
  return String(token || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^"|"$/g, "");
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

    // ✅ Prefer token passed in (so we don't accidentally read a bad/old token from DB)
    let igAccessToken = sanitizeAccessToken(igAccessTokenOverride);

    // If not passed, fallback to DB
    if (!igAccessToken) {
      const db = await connectDB();
      const clients = db.collection("Clients");

      const clientDoc = await clients.findOne({ igId: igIdStr });

      if (!clientDoc || !clientDoc.igAccessToken) {
        console.error("❌ Missing IG client or igAccessToken for igId:", igIdStr);
        return;
      }

      igAccessToken = sanitizeAccessToken(clientDoc.igAccessToken);
    }

    // ✅ Quick sanity check
    if (!igAccessToken || igAccessToken.length < 60) {
      console.error("❌ Invalid IG access token (empty/too short). Cannot send IG message.");
      console.error("Token preview:", igAccessToken ? `${igAccessToken.slice(0, 10)}...${igAccessToken.slice(-6)}` : "(empty)");
      return;
    }

    // ⚠️ Use a single Graph version across your app if possible. Keeping yours at v21.0.
    const url = `https://graph.facebook.com/v21.0/${igIdStr}/messages?access_token=${encodeURIComponent(
      igAccessToken
    )}`;

    const payload = {
      recipient: { id: psid },
      message: { text },
    };

    console.log(`📤 Sending IG reply to ${psid}:`, text);
    console.log("🔑 IG token length:", igAccessToken.length);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
