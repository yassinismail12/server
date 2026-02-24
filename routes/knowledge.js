import express from "express";
import multer from "multer";
import jwt from "jsonwebtoken";

import Client from "../Client.js";                // adjust path if needed
import KnowledgeChunk from "../KnowledgeChunk.js"; // ✅ same model used by retrieveChunks
import { chunkSection } from "../utils/chunking.js"; // your general chunker

const router = express.Router();

/* ---------------------------
   Auth (cookie token)
---------------------------- */
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

  if (req.user.role === "admin") return next();

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

/* ---------------------------
   Upload (memory)
---------------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

/* ---------------------------
   Helpers
---------------------------- */
function normalizeText(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\x20-\x7E\n\u0600-\u06FF]/g, "") // keep Arabic too
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert quick form -> one blob with headings.
 * We will SPLIT this later into sections.
 */
function formToMixedText(data = {}) {
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

/**
 * ✅ Split "mixed" heading text into real sections:
 * faqs / offers / hours / profile / contact / other
 */
function splitMixedToSections(mixedText = "") {
  const text = normalizeText(mixedText);
  if (!text) return {};

  const mapTitleToSection = (title) => {
    const t = String(title || "").toLowerCase().trim();
    if (t.includes("faq")) return "faqs";
    if (t.includes("working hours") || t === "hours") return "hours";
    if (t.includes("services") || t.includes("offers")) return "offers";
    if (t.includes("phone") || t.includes("whatsapp") || t.includes("contact")) return "contact";
    if (t.includes("business name") || t.includes("business type") || t.includes("city")) return "profile";
    return "other";
  };

  const lines = text.split("\n");
  const out = {};
  let current = null;

  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      current = mapTitleToSection(m[1]);
      out[current] ||= [];
      continue;
    }
    if (current) out[current].push(line);
  }

  const result = {};
  for (const k of Object.keys(out)) {
    result[k] = normalizeText(out[k].join("\n"));
  }
  return result;
}

/**
 * ✅ FAQ chunker: 1 chunk per Q/A block
 * Supports:
 *  - Q? newline A...
 *  - Blank lines separate blocks
 */
function chunkFaqs(faqText = "") {
  const t = normalizeText(faqText);
  if (!t) return [];
  const blocks = t.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => `FAQ:\n${b}`);
}

/**
 * Decide which sections your bot uses
 * (You can edit later)
 */
function chooseSections(botType) {
  if (botType === "restaurant") return ["menu", "offers", "hours", "faqs"];
  // default real-estate
  return ["listings", "paymentPlans", "offers", "hours", "faqs", "profile", "contact"];
}

/**
 * Get text for a section from Client
 * - Prefer files[]
 * - fallback old fields
 */
function pickTextFromClient(client, key) {
  const file = (client.files || []).find(
    (f) => String(f.name || "").toLowerCase() === String(key || "").toLowerCase()
  );
  if (file?.content) return file.content;

  if (key === "faqs") return client.faqs || "";
  if (key === "listings") return client.listingsData || "";
  if (key === "paymentPlans") return client.paymentPlans || "";

  // optional fallback fields if you later store them:
  if (key === "hours") return client.hours || "";
  if (key === "offers") return client.offers || "";

  return "";
}

/**
 * Save/replace a file in client.files[]
 */
async function upsertClientFile(client, fileName, content, label = "bot-build") {
  const name = String(fileName || "").trim() || "mixed";
  const clean = normalizeText(content);

  if (!clean) return;

  const idx = (client.files || []).findIndex(
    (f) => String(f.name || "").toLowerCase() === name.toLowerCase()
  );

  if (idx >= 0) {
    client.files[idx].content = clean;
    client.files[idx].label = label;
    client.files[idx].createdAt = new Date();
  } else {
    client.files.push({ name, label, content: clean, createdAt: new Date() });
  }
}

/**
 * ✅ The ONE rebuild function
 * - deletes old chunks (clientId+botType)
 * - splits mixed into real sections
 * - builds chunks per section
 * - updates client gate fields
 */
async function rebuildKnowledge({ clientId, botType = "default" }) {
  const client = await Client.findOne({ clientId });
  if (!client) return { ok: false, status: 404, error: "Client not found" };

  // mark building (persist even if schema doesn't have it)
  await Client.updateOne({ clientId }, { $set: { knowledgeStatus: "building" } });

  // ✅ Delete old chunks from SAME storage used by retrieval
  await KnowledgeChunk.deleteMany({ clientId, botType });

  // ✅ If there is a mixed file, split and upsert sections
  const mixedFile = (client.files || []).find(
    (f) => String(f.name || "").toLowerCase() === "mixed"
  );

  if (mixedFile?.content) {
    const parts = splitMixedToSections(mixedFile.content);

    // store split parts as separate files (so future rebuilds are cleaner)
    for (const [section, text] of Object.entries(parts)) {
      if (text) await upsertClientFile(client, section, text, "mixed-split");
    }
    await client.save();
  }

  const sections = chooseSections(botType);

  const docs = [];
  for (const section of sections) {
    const raw = normalizeText(pickTextFromClient(client, section));
    if (!raw) continue;

    let chunks = [];

    if (section === "faqs") {
      chunks = chunkFaqs(raw);
    } else {
      chunks = chunkSection(section, raw) || [];
    }

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

  if (docs.length) {
    await KnowledgeChunk.insertMany(docs);
  }

  const hasChunks = docs.length > 0;

  await Client.updateOne(
    { clientId },
    {
      $set: {
        botBuilt: hasChunks,
        knowledgeStatus: hasChunks ? "ready" : "empty",
        knowledgeBotType: botType,
        knowledgeBuiltAt: new Date(),
      },
      $inc: { knowledgeVersion: 1 },
    }
  );

  return {
    ok: true,
    clientId,
    botType,
    inserted: docs.length,
    sections,
    knowledgeStatus: hasChunks ? "ready" : "empty",
  };
}

/* ---------------------------
   Endpoints
---------------------------- */

/**
 * GET /api/knowledge/status?clientId=...&botType=default
 */
router.get("/status", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const clientId = String(req.query.clientId || "").trim();
    const botType = String(req.query.botType || "default").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const count = await KnowledgeChunk.countDocuments({ clientId, botType });

    const ready =
      Boolean(client.botBuilt) ||
      count > 0 ||
      Number(client.knowledgeVersion || 0) >= 1 ||
      String(client.knowledgeStatus || "") === "ready";

    return res.json({
      ok: true,
      clientId,
      botType,
      status: ready ? "ready" : "empty",
      ready,
      version: Number(client.knowledgeVersion || 0) || 0,
      knowledgeStatus: client.knowledgeStatus || (ready ? "ready" : "empty"),
      botBuilt: Boolean(client.botBuilt),
      knowledgeBuiltAt: client.knowledgeBuiltAt || null,
      chunks: count,
    });
  } catch (err) {
    console.error("❌ /api/knowledge/status error:", err);
    return res.status(500).json({ ok: false, error: "Status failed" });
  }
});

/**
 * POST /api/knowledge/build
 * Body:
 * - { clientId, inputType:"form", data:{...}, botType? }
 * - { clientId, inputType:"text", section:"faqs|offers|hours|listings|mixed", text:"...", botType? }
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
      content = formToMixedText(req.body?.data || {});
      fileName = "mixed";
    } else if (inputType === "text") {
      fileName = String(req.body?.section || "mixed").trim() || "mixed";
      content = normalizeText(req.body?.text || "");
    } else {
      return res.status(400).json({ ok: false, error: "Invalid inputType. Use 'form' or 'text'." });
    }

    if (!content) return res.status(400).json({ ok: false, error: "No content to save." });

    await upsertClientFile(client, fileName, content, "bot-build");
    await client.save();

    const built = await rebuildKnowledge({ clientId, botType: botType || "default" });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({ ok: true, savedAs: fileName, build: built });
  } catch (err) {
    console.error("❌ /api/knowledge/build error:", err);
    return res.status(500).json({ ok: false, error: "Build failed" });
  }
});

/**
 * POST /api/knowledge/upload
 * multipart/form-data:
 * - clientId
 * - section
 * - botType (optional)
 * - file (.txt)
 */
router.post("/upload", verifyToken, requireClientOwnership, upload.single("file"), async (req, res) => {
  try {
    const clientId = String(req.body?.clientId || "").trim();
    const section = String(req.body?.section || "mixed").trim() || "mixed";
    const botType = String(req.body?.botType || "default").trim();

    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const mimetype = req.file.mimetype || "";
    if (!mimetype.includes("text")) {
      return res.status(400).json({ ok: false, error: "Only text/plain supported here." });
    }

    const content = normalizeText(req.file.buffer.toString("utf8"));
    if (!content) return res.status(400).json({ ok: false, error: "Empty file." });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    await upsertClientFile(client, section, content, "bot-upload");
    await client.save();

    const built = await rebuildKnowledge({ clientId, botType });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({ ok: true, savedAs: section, build: built });
  } catch (err) {
    console.error("❌ /api/knowledge/upload error:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

/**
 * POST /api/knowledge/rebuild/:clientId
 * Body: { botType?: "default" }
 */
router.post("/rebuild/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();
    const botType = String(req.body?.botType || "default").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    const built = await rebuildKnowledge({ clientId, botType });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json(built);
  } catch (err) {
    console.error("❌ /api/knowledge/rebuild error:", err);
    return res.status(500).json({ ok: false, error: "Rebuild failed" });
  }
});

export default router;