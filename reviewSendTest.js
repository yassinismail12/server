// reviewSendTest.js
import express from "express";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

async function connectDB() {
  if (!mongoClient.topology?.isConnected()) await mongoClient.connect();
  return mongoClient.db(dbName);
}

router.post("/api/review/send-test", async (req, res) => {
  try {
    const { pageId, psid, text } = req.body;

    if (!pageId || !psid || !text) {
      return res.status(400).json({ error: "Missing pageId/psid/text" });
    }

    // 1) get Page token from DB
    const db = await connectDB();
    const clients = db.collection("clients"); // change if your collection name differs

    const clientDoc = await clients.findOne({ pageId: String(pageId).trim() });
    if (!clientDoc?.PAGE_ACCESS_TOKEN) {
      return res.status(404).json({ error: "No PAGE_ACCESS_TOKEN found for this pageId" });
    }

    const PAGE_ACCESS_TOKEN = clientDoc.PAGE_ACCESS_TOKEN || clientDoc.PAGE_ACCESS_TOKEN; 
    // ^ adjust this line to match your exact field name (PAGE_ACCESS_TOKEN vs PAGE_ACCESS_TOKEN)

    // 2) call Meta Send API
    const url = `https://graph.facebook.com/v20.0/${pageId}/messages?access_token=${encodeURIComponent(
      PAGE_ACCESS_TOKEN
    )}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text },
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(400).json({ ok: false, metaError: data });
    }

    // success
    return res.json({ ok: true, meta: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

export default router;
