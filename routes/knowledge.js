import express from "express";
import Client from "../Client.js"; // adjust path
import { connectToDB } from "../services/db.js"; // adjust path to your connectToDB module
import { chunkSection } from "../utils/chunking.js"; // the chunking helper we made

const router = express.Router();

function pickTextFromClient(client, key) {
  // 1) Prefer files[]
  const file = (client.files || []).find(f => (f.name || "").toLowerCase() === key.toLowerCase());
  if (file?.content) return file.content;

  // 2) Fallback to old fields
  if (key === "faqs") return client.faqs || "";
  if (key === "listings") return client.listingsData || "";
  if (key === "paymentPlans") return client.paymentPlans || "";

  return "";
}

router.post("/rebuild/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const botType = req.body?.botType || "default";

  const client = await Client.findOne({ clientId });
  if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

  const db = await connectToDB();
  const chunksCol = db.collection("knowledge_chunks");

  // Choose sections based on botType (you can expand this)
  const sections =
    botType === "restaurant"
      ? ["menu", "offers", "hours"]
      : ["listings", "paymentPlans", "faqs"];

  // delete old
  await chunksCol.deleteMany({ clientId, botType });

  // build new
  const docs = [];
  for (const section of sections) {
    const raw = pickTextFromClient(client, section);
    const chunks = chunkSection(section, raw);

    for (const text of chunks) {
      docs.push({
        clientId,
        botType,
        section,
        text,
        createdAt: new Date(),
      });
    }
  }

  if (docs.length) await chunksCol.insertMany(docs);

  return res.json({
    ok: true,
    clientId,
    botType,
    inserted: docs.length,
    sections,
  });
});

export default router;
