import express from "express";
import multer from "multer";
import jwt from "jsonwebtoken";

import Client from "../Client.js";              // adjust path if needed
import { connectToDB } from "../services/db.js"; // your Mongo native connection helper
import { chunkSection } from "../utils/chunking.js"; // your chunker

const router = express.Router();

// -------------------------
// Auth (cookie token)
// -------------------------
function verifyToken(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, clientId }
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

function requireClientOwnership(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  // admin can do anything
  if (req.user.role === "admin") return next();

  // client can only use their own clientId
  const clientId =
    req.body?.clientId ||
    req.params?.clientId ||
    req.params?.id ||
    req.query?.clientId;

  if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

  if (String(clientId) !== String(req.user.clientId)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  next();
}

// -------------------------
// Upload (memory)
// -------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

// -------------------------
// Helpers
// -------------------------
function normalizeText(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert your quick form -> one text blob with headings
 * (So your chunker can split nicely)
 */
function formToText(data = {}) {
  const lines = [];

  const push = (title, value) => {
    const v = normalizeText(value);
    if (!v) return;
    lines.push(`## ${title}\n${v}\n`);
  };

  push("Business Name", data.businessName);
  push("Business Type", data.businessType);
  push("City / Areas Served", data.cityArea);
  push("Working Hours", data.hours);
  push("Phone / WhatsApp", data.phoneWhatsapp);
  push("Services", data.services);
  push("FAQs", data.faqs);

  return normalizeText(lines.join("\n"));
}

function chooseSections(botType) {
  return botType === "restaurant"
    ? ["menu", "offers", "hours"]
    : ["listings", "paymentPlans", "faqs"];
}

function pickTextFromClient(client, key) {
  // 1) Prefer files[]
  const file = (client.files || []).find(
    (f) => String(f.name || "").toLowerCase() === String(key || "").toLowerCase()
  );
  if (file?.content) return file.content;

  // 2) Fallback to old fields
  if (key === "faqs") return client.faqs || "";
  if (key === "listings") return client.listingsData || "";
  if (key === "paymentPlans") return client.paymentPlans || "";

  return "";
}

async function rebuildKnowledge({ clientId, botType = "default" }) {
  const client = await Client.findOne({ clientId });
  if (!client) {
    return { ok: false, status: 404, error: "Client not found" };
  }

  const db = await connectToDB();
  const chunksCol = db.collection("knowledge_chunks");

  const sections = chooseSections(botType);

  // delete old chunks for this client/botType
  await chunksCol.deleteMany({ clientId, botType });

  // build new chunks
  const docs = [];
  for (const section of sections) {
    const raw = normalizeText(pickTextFromClient(client, section));
    if (!raw) continue;

    const chunks = chunkSection(section, raw) || [];
    for (const text of chunks) {
      const t = normalizeText(text);
      if (!t) continue;
      docs.push({
        clientId,
        botType,
        section,
        text: t,
        createdAt: new Date(),
      });
    }
  }

  if (docs.length) await chunksCol.insertMany(docs);

  // update client status fields (for dashboard gate)
  const nextVersion = Number(client.knowledgeVersion || 0) + 1;

  client.botBuilt = docs.length > 0;
  client.knowledgeStatus = docs.length > 0 ? "ready" : "empty";
  client.knowledgeVersion = nextVersion;
  client.knowledgeBuiltAt = new Date();

  await client.save();

  return {
    ok: true,
    clientId,
    botType,
    inserted: docs.length,
    sections,
    knowledgeStatus: client.knowledgeStatus,
    knowledgeVersion: client.knowledgeVersion,
    botBuilt: client.botBuilt,
  };
}

// -------------------------
// Endpoints
// -------------------------

/**
 * GET /api/knowledge/status?clientId=...
 * Used by dashboard gate fallback
 */
router.get("/status", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const clientId = String(req.query.clientId || "").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    // We can also check if chunks exist:
    const db = await connectToDB();
    const chunksCol = db.collection("knowledge_chunks");
    const count = await chunksCol.countDocuments({ clientId }, { limit: 1 });

    const ready = Boolean(client.botBuilt) || count > 0 || Number(client.knowledgeVersion || 0) >= 1;

    return res.json({
      ok: true,
      clientId,
      status: ready ? "ready" : "empty",
      ready,
      version: Number(client.knowledgeVersion || 0) || 0,
      knowledgeStatus: client.knowledgeStatus || (ready ? "ready" : "empty"),
      botBuilt: Boolean(client.botBuilt),
      knowledgeBuiltAt: client.knowledgeBuiltAt || null,
    });
  } catch (err) {
    console.error("❌ /api/knowledge/status error:", err);
    return res.status(500).json({ ok: false, error: "Status failed" });
  }
});

/**
 * POST /api/knowledge/build
 * Body:
 *  - { clientId, inputType: "form", data: {...}, botType? }
 *  - { clientId, inputType: "text", section: "faqs|listings|hours|mixed", text: "...", botType? }
 *
 * Saves into Client.files[] then rebuilds knowledge_chunks.
 */
router.post("/build", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId, inputType, botType } = req.body || {};
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    let fileName = "mixed";
    let content = "";

    if (inputType === "form") {
      content = formToText(req.body?.data || {});
      fileName = "mixed";
    } else if (inputType === "text") {
      fileName = String(req.body?.section || "mixed");
      content = normalizeText(req.body?.text || "");
    } else {
      return res.status(400).json({ ok: false, error: "Invalid inputType. Use 'form' or 'text'." });
    }

    if (!content) return res.status(400).json({ ok: false, error: "No content to save." });

    // Save/replace file in files[]
    const idx = (client.files || []).findIndex(
      (f) => String(f.name || "").toLowerCase() === fileName.toLowerCase()
    );

    if (idx >= 0) {
      client.files[idx].content = content;
      client.files[idx].createdAt = new Date();
    } else {
      client.files.push({ name: fileName, label: "bot-build", content, createdAt: new Date() });
    }

    await client.save();

    // Rebuild chunks from client stored data
    const built = await rebuildKnowledge({ clientId, botType: botType || "default" });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({
      ok: true,
      savedAs: fileName,
      build: built,
    });
  } catch (err) {
    console.error("❌ /api/knowledge/build error:", err);
    return res.status(500).json({ ok: false, error: "Build failed" });
  }
});

/**
 * POST /api/knowledge/upload
 * multipart/form-data:
 *  - clientId
 *  - section (faqs|listings|hours|mixed)
 *  - file (.txt)
 */
router.post("/upload", verifyToken, requireClientOwnership, upload.single("file"), async (req, res) => {
  try {
    const clientId = String(req.body?.clientId || "").trim();
    const section = String(req.body?.section || "mixed").trim();
    const botType = String(req.body?.botType || "default").trim();

    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    // Only accept text
    const mimetype = req.file.mimetype || "";
    if (!mimetype.includes("text")) {
      return res.status(400).json({ ok: false, error: "Only text/plain files supported here." });
    }

    const content = normalizeText(req.file.buffer.toString("utf8"));
    if (!content) return res.status(400).json({ ok: false, error: "Empty file." });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    // Save/replace in files[]
    const idx = (client.files || []).findIndex(
      (f) => String(f.name || "").toLowerCase() === section.toLowerCase()
    );

    if (idx >= 0) {
      client.files[idx].content = content;
      client.files[idx].createdAt = new Date();
    } else {
      client.files.push({ name: section, label: "bot-upload", content, createdAt: new Date() });
    }

    await client.save();

    const built = await rebuildKnowledge({ clientId, botType });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({
      ok: true,
      savedAs: section,
      build: built,
    });
  } catch (err) {
    console.error("❌ /api/knowledge/upload error:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

/**
 * POST /api/knowledge/rebuild/:clientId
 * FIXED: safe body access + supports frontend fallback
 */
router.post("/rebuild/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();
    const botType = req.body?.botType || "default"; // ✅ FIXED (no crash)

    const built = await rebuildKnowledge({ clientId, botType });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json(built);
  } catch (err) {
    console.error("❌ /api/knowledge/rebuild error:", err);
    return res.status(500).json({ ok: false, error: "Rebuild failed" });
  }
});

export default router;