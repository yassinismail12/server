import express from "express";
import Dataset from "../Dataset.js";
import KnowledgeChunk from "../KnowledgeChunk.js";
import { chunkSection } from "../utils/chunking.js";

const router = express.Router();

router.post("/save", async (req, res) => {
  const { clientId, botType = "default", rawSections = {} } = req.body;

  if (!clientId) return res.status(400).json({ ok: false, error: "clientId required" });

  // 1) Save raw
  await Dataset.findOneAndUpdate(
    { clientId, botType },
    { rawSections, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  // 2) Replace chunks
  await KnowledgeChunk.deleteMany({ clientId, botType });

  const docs = [];
  for (const [section, text] of Object.entries(rawSections)) {
    const chunks = chunkSection(section, text);
    for (const c of chunks) {
      docs.push({ clientId, botType, section, text: c });
    }
  }

  if (docs.length) await KnowledgeChunk.insertMany(docs);

  res.json({ ok: true, chunksInserted: docs.length });
});

export default router;
