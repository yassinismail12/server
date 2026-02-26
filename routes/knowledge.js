// routes/knowledge.js
import express from "express";
import multer from "multer";
import jwt from "jsonwebtoken";

import Client from "../Client.js";
import KnowledgeChunk from "../KnowledgeChunk.js";
import { chunkSection } from "../utils/chunking.js";

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

  const clientId = req.body?.clientId || req.params?.clientId || req.params?.id || req.query?.clientId;
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

function canonicalSectionName(s) {
  const t = String(s || "").toLowerCase().trim();
  if (["faq", "faqs", "qna"].includes(t)) return "faqs";
  if (["hour", "hours", "workinghours"].includes(t)) return "hours";
  if (["service", "services", "offers", "pricing"].includes(t)) return "offers";
  if (["listing", "listings", "properties", "units", "inventory"].includes(t)) return "listings";
  if (["payment", "paymentplans", "plans", "installments"].includes(t)) return "paymentPlans";
  if (["policy", "policies", "rules"].includes(t)) return "policies";
  if (["contact", "phone", "whatsapp", "address"].includes(t)) return "contact";
  if (["profile", "about"].includes(t)) return "profile";
  if (["mixed"].includes(t)) return "mixed";
  return t || "mixed";
}

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

  push("Listings", data.listingsSummary);
  push("Payment Plans", data.paymentPlans);
  push("Policies", data.policies);

  return normalizeText(lines.join("\n"));
}

function splitMixedToSections(mixedText = "") {
  const text = normalizeText(mixedText);
  if (!text) return {};

  const mapTitleToSection = (title) => {
    const t = String(title || "").toLowerCase().trim();

    if (t.includes("faq")) return "faqs";
    if (t.includes("working hours") || t === "hours" || t.includes("open")) return "hours";
    if (t.includes("services") || t.includes("offers") || t.includes("pricing")) return "offers";

    if (t.includes("listing") || t.includes("properties") || t.includes("inventory") || t.includes("units")) return "listings";
    if (t.includes("payment") || t.includes("installment") || t.includes("plan")) return "paymentPlans";
    if (t.includes("policy") || t.includes("policies") || t.includes("rules")) return "policies";

    if (t.includes("phone") || t.includes("whatsapp") || t.includes("contact") || t.includes("address")) return "contact";
    if (t.includes("business name") || t.includes("business type") || t.includes("city")) return "profile";

    return "other";
  };

  const lines = text.split("\n");
  const out = {};
  let current = null;
  let sawHeading = false;

  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      sawHeading = true;
      current = mapTitleToSection(m[1]);
      out[current] ||= [];
      continue;
    }
    if (current) out[current].push(line);
  }

  if (!sawHeading) return { other: text };

  const result = {};
  for (const k of Object.keys(out)) {
    result[k] = normalizeText(out[k].join("\n"));
  }
  return result;
}

function chunkFaqs(faqText = "") {
  const t = normalizeText(faqText);
  if (!t) return [];
  const blocks = t.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => `FAQ:\n${b}`);
}

function chooseSections(botType) {
  const bt = String(botType || "default").toLowerCase().trim();

  if (bt === "restaurant") return ["menu", "offers", "hours", "faqs", "contact", "profile", "policies", "other"];
  if (bt === "realestate") return ["listings", "paymentPlans", "offers", "hours", "faqs", "policies", "profile", "contact", "other"];

  // default generic (pharmacy/clinic/anything)
  return ["offers", "hours", "faqs", "policies", "profile", "contact", "other"];
}

function pickTextFromClient(client, key) {
  const wanted = String(key || "").toLowerCase();
  const file = (client.files || []).find((f) => String(f.name || "").toLowerCase() === wanted);
  return file?.content || "";
}

async function upsertClientFile(client, fileName, content, label = "bot-build") {
  const name = canonicalSectionName(fileName || "mixed");
  const clean = normalizeText(content);
  if (!clean) return;

  client.files ||= [];
  const idx = client.files.findIndex((f) => String(f.name || "").toLowerCase() === name.toLowerCase());

  if (idx >= 0) {
    client.files[idx].content = clean;
    client.files[idx].label = label;
    client.files[idx].createdAt = new Date();
  } else {
    client.files.push({ name, label, content: clean, createdAt: new Date() });
  }
}

function resetClientKnowledgeSources(client) {
  client.files = [];
  client.faqs = "";
  client.listingsData = "";
  client.paymentPlans = "";
  client.hours = "";
  client.offers = "";
}

/**
 * ✅ KEY FIXES:
 * 1) replace=true MUST NOT wipe client.files AFTER you saved new content.
 *    So: we ONLY delete chunks here. Source reset happens in /build and /upload BEFORE saving.
 * 2) We also auto-include sections that exist in client.files (so listings/paymentPlans won't be skipped on default).
 */
function detectSectionsFromClient(client, botType) {
  const base = new Set(chooseSections(botType));

  // include any sections that exist in files (except "mixed")
  for (const f of client.files || []) {
    const name = canonicalSectionName(f.name);
    if (name && name !== "mixed") base.add(name);
  }

  // always include other
  base.add("other");

  return Array.from(base);
}

async function rebuildKnowledge({ clientId, botType = "default", replace = false }) {
  const client = await Client.findOne({ clientId });
  if (!client) return { ok: false, status: 404, error: "Client not found" };

  await Client.updateOne({ clientId }, { $set: { knowledgeStatus: "building" } });

  // ✅ replace: delete ALL chunks for client (all botTypes) to prevent mixing
  if (replace) {
    await KnowledgeChunk.deleteMany({ clientId });
  } else {
    await KnowledgeChunk.deleteMany({ clientId, botType });
  }

  // split mixed -> real sections (do NOT clear files here)
  const mixedFile = (client.files || []).find((f) => String(f.name || "").toLowerCase() === "mixed");
  if (mixedFile?.content) {
    const parts = splitMixedToSections(mixedFile.content);
    for (const [section, text] of Object.entries(parts)) {
      if (text) await upsertClientFile(client, section, text, "mixed-split");
    }
  }

  await client.save();

  // ✅ IMPORTANT: auto-detect sections from files so listings/paymentPlans don't get skipped
  const sections = detectSectionsFromClient(client, botType);

  const docs = [];
  for (const section of sections) {
    const raw = normalizeText(pickTextFromClient(client, section));
    if (!raw) continue;

    const chunks = section === "faqs" ? chunkFaqs(raw) : chunkSection(section, raw) || [];

    for (const text of chunks) {
      const t = normalizeText(text);
      if (!t) continue;
      docs.push({ clientId, botType, section, text: t, createdAt: new Date() });
    }
  }

  if (docs.length) await KnowledgeChunk.insertMany(docs);

  const hasChunks = docs.length > 0;
  const presentSections = [...new Set(docs.map((d) => d.section))];
  const expectedSections = sections;

  const missingSections = expectedSections.filter((s) => !presentSections.includes(s));
  const coverageWarnings = [];

  if (missingSections.length > 0) coverageWarnings.push(`Missing sections: ${missingSections.join(", ")}`);
  if (expectedSections.includes("listings") && !presentSections.includes("listings")) coverageWarnings.push("No listings detected.");
  if (expectedSections.includes("paymentPlans") && !presentSections.includes("paymentPlans")) coverageWarnings.push("No payment plans detected.");
  if (expectedSections.includes("faqs") && !presentSections.includes("faqs")) coverageWarnings.push("No FAQs detected.");

  let finalStatus = "empty";
  if (hasChunks && coverageWarnings.length === 0) finalStatus = "ready";
  if (hasChunks && coverageWarnings.length > 0) finalStatus = "needs_review";

  await Client.updateOne(
    { clientId },
    {
      $set: {
        botBuilt: hasChunks,
        knowledgeStatus: finalStatus,
        knowledgeBotType: botType,
        knowledgeBuiltAt: new Date(),
        sectionsPresent: presentSections,
        coverageWarnings,
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
    replace: Boolean(replace),
    knowledgeStatus: finalStatus,
    sectionsPresent: presentSections,
    coverageWarnings,
  };
}

/* ---------------------------
   Endpoints
---------------------------- */

router.get("/status", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const clientId = String(req.query.clientId || "").trim();
    const botType = String(req.query.botType || "default").trim();
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const count = await KnowledgeChunk.countDocuments({ clientId, botType });

    const status = String(client.knowledgeStatus || "").trim() || (count > 0 ? "ready" : "empty");
    const ready = status === "ready" || status === "needs_review" || count > 0;

    return res.json({
      ok: true,
      clientId,
      botType,
      status,
      ready,
      version: Number(client.knowledgeVersion || 0) || 0,
      knowledgeStatus: status,
      botBuilt: Boolean(client.botBuilt),
      knowledgeBuiltAt: client.knowledgeBuiltAt || null,
      chunks: count,
      sectionsPresent: Array.isArray(client.sectionsPresent) ? client.sectionsPresent : [],
      coverageWarnings: Array.isArray(client.coverageWarnings) ? client.coverageWarnings : [],
    });
  } catch (err) {
    console.error("❌ /api/knowledge/status error:", err);
    return res.status(500).json({ ok: false, error: "Status failed" });
  }
});

router.post("/build", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId, inputType, botType, replace } = req.body || {};
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const doReplace = Boolean(replace);

    // ✅ IMPORTANT: reset sources BEFORE saving new content (this is where replace belongs)
    if (doReplace) resetClientKnowledgeSources(client);

    let fileName = "mixed";
    let content = "";

    if (inputType === "form") {
      content = formToMixedText(req.body?.data || {});
      fileName = "mixed";
    } else if (inputType === "text") {
      fileName = canonicalSectionName(req.body?.section || "mixed");
      content = normalizeText(req.body?.text || "");
    } else {
      return res.status(400).json({ ok: false, error: "Invalid inputType. Use 'form' or 'text'." });
    }

    if (!content) return res.status(400).json({ ok: false, error: "No content to save." });

    await upsertClientFile(client, fileName, content, doReplace ? "bot-build-replace" : "bot-build");
    await client.save();

    const built = await rebuildKnowledge({ clientId, botType: botType || "default", replace: doReplace });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({ ok: true, savedAs: fileName, build: built });
  } catch (err) {
    console.error("❌ /api/knowledge/build error:", err);
    return res.status(500).json({ ok: false, error: "Build failed" });
  }
});

router.post("/upload", verifyToken, requireClientOwnership, upload.single("file"), async (req, res) => {
  try {
    const clientId = String(req.body?.clientId || "").trim();
    const sectionRaw = String(req.body?.section || "mixed").trim() || "mixed";
    const section = canonicalSectionName(sectionRaw);
    const botType = String(req.body?.botType || "default").trim();
    const replace = String(req.body?.replace || "").toLowerCase() === "true";

    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const mimetype = req.file.mimetype || "";
    const name = req.file.originalname || "";
    const isTxt = name.toLowerCase().endsWith(".txt");

    if (!mimetype.includes("text") && !isTxt) return res.status(400).json({ ok: false, error: "Only .txt supported." });

    const content = normalizeText(req.file.buffer.toString("utf8"));
    if (!content) return res.status(400).json({ ok: false, error: "Empty file." });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    // ✅ replace reset BEFORE saving new file
    if (replace) resetClientKnowledgeSources(client);

    await upsertClientFile(client, section, content, replace ? "bot-upload-replace" : "bot-upload");
    await client.save();

    const built = await rebuildKnowledge({ clientId, botType, replace });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({ ok: true, savedAs: section, build: built });
  } catch (err) {
    console.error("❌ /api/knowledge/upload error:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

router.post("/rebuild/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const clientId = String(req.params.clientId || "").trim();
    const botType = String(req.body?.botType || "default").trim();
    const replace = Boolean(req.body?.replace);

    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    // ⚠️ rebuild-only replace will delete chunks but will NOT wipe files here.
    // If you want wipe+rebuild, use /build or /upload with replace=true.
    const built = await rebuildKnowledge({ clientId, botType, replace });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json(built);
  } catch (err) {
    console.error("❌ /api/knowledge/rebuild error:", err);
    return res.status(500).json({ ok: false, error: "Rebuild failed" });
  }
});

export default router;