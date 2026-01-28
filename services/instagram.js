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

function sanitizeAccessToken(token) {
  // remove quotes, Bearer prefix, normal whitespace + common zero-width chars
  return String(token || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^"|"$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function tokenPreview(t) {
  if (!t) return "(empty)";
  return `${t.slice(0, 10)}...${t.slice(-6)}`;
}

/**
 * Send an Instagram DM reply
 * @param {string} psid
 * @param {string} text
 * @param {string} igId
 * @param {string} [igAccessTokenOverride]
 */
export async function sendInstagramReply(psid, text, igId, igAccessTokenOverride = null) {
  try {
    const igIdStr = normalizeIgId(igId);

    // prefer caller token
    let token = sanitizeAccessToken(igAccessTokenOverride);

    if (!token) {
      const db = await connectDB();
      const clientDoc = await db.collection("Clients").findOne({ igId: igIdStr });
      token = sanitizeAccessToken(clientDoc?.igAccessToken);
    }

    console.log("🔑 IG token length:", token.length);
    console.log("🔑 IG token preview:", tokenPreview(token));

    if (!token || token.length < 60) {
      console.error("❌ Invalid IG access token (empty/too short).");
      return;
    }

    const url = `https://graph.facebook.com/v21.0/${igIdStr}/messages`;

    const payload = {
      recipient: { id: psid },
      message: { text },
    };

    console.log(`📤 Sending IG reply to ${psid}:`, text);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`, // ✅ this is the key change
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
