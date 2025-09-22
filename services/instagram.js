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

/**
 * Send an Instagram DM reply
 * @param {string} psid - Instagram user PSID
 * @param {string} text - Message text
 * @param {string} igId - Instagram Page/IG account ID
 */
export async function sendInstagramReply(psid, text, igId) {
    try {
        const db = await connectDB();
        const clients = db.collection("Clients");
        const igIdStr = normalizeIgId(igId);

        // Fetch client doc to get PAGE_ACCESS_TOKEN
        const clientDoc = await clients.findOne({ igId: igIdStr });

        if (!clientDoc || !clientDoc.igAcessToken) {
            console.error("❌ Missing IG client or PAGE_ACCESS_TOKEN for igId:", igIdStr);
            return;
        }

        const PAGE_ACCESS_TOKEN = clientDoc.igAccessToken;

        const url = `https://graph.facebook.com/v21.0/${igIdStr}/messages?access_token=${PAGE_ACCESS_TOKEN}`;

        const payload = {
            recipient: { id: psid },
            message: { text }
        };

        console.log(`📤 Sending IG reply to ${psid}:`, text);

        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
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
