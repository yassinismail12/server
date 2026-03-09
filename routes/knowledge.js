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

  // FAQs
  if (
    ["faq", "faqs", "qna", "questions", "common questions", "frequently asked questions"].includes(t)
  ) return "faqs";

  // Hours
  if (
    [
      "hour",
      "hours",
      "workinghours",
      "working hours",
      "business hours",
      "opening hours",
      "open hours",
      "schedule",
      "timings",
      "availability",
    ].includes(t)
  ) return "hours";

  // Offers / services / pricing
  if (
    [
      "service",
      "services",
      "offers",
      "pricing",
      "prices",
      "fees",
      "consultation fees",
      "consultationfees",
      "packages",
      "plans",
      "treatments",
    ].includes(t)
  ) return "offers";

  // Menu
  if (
    [
      "menu",
      "food menu",
      "drink menu",
      "restaurant menu",
      "items",
      "menu items",
    ].includes(t)
  ) return "menu";

  // Products
  if (
    [
      "product",
      "products",
      "catalog",
      "catalogue",
      "shop",
      "store items",
      "inventory products",
      "product list",
      "collection",
      "collections",
      "categories",
    ].includes(t)
  ) return "products";

  // Listings / real estate / units
  if (
    [
      "listing",
      "listings",
      "properties",
      "units",
      "inventory",
      "apartments",
      "villas",
      "properties for sale",
      "properties for rent",
    ].includes(t)
  ) return "listings";

  // Payment plans
  if (
    [
      "payment",
      "paymentplans",
      "payment plans",
      "installments",
      "installment plans",
      "finance options",
      "financing",
    ].includes(t)
  ) return "paymentPlans";

  // Booking / appointments
  if (
    [
      "booking",
      "bookings",
      "appointment",
      "appointments",
      "reservation",
      "reservations",
      "table booking",
      "table reservation",
    ].includes(t)
  ) return "booking";

  // Policies
  if (
    [
      "policy",
      "policies",
      "rules",
      "terms",
      "refund policy",
      "return policy",
      "exchange policy",
      "cancellation policy",
      "privacy policy",
      "shipping policy",
      "warranty",
      "warranties",
    ].includes(t)
  ) return "policies";

  // Contact
  if (
    [
      "contact",
      "phone",
      "whatsapp",
      "address",
      "location",
      "office location",
      "office address",
      "email",
      "contact information",
      "branch contact",
      "branches",
    ].includes(t)
  ) return "contact";

  // Profile
  if (
    [
      "profile",
      "about",
      "about us",
      "business name",
      "business type",
      "city",
      "areas served",
      "company profile",
      "who we are",
    ].includes(t)
  ) return "profile";

  // Team / doctors / staff
  if (
    [
      "team",
      "staff",
      "doctors",
      "doctor",
      "specialists",
      "employees",
      "trainers",
      "teachers",
      "instructors",
    ].includes(t)
  ) return "team";

  // Courses / education
  if (
    [
      "courses",
      "course",
      "programs",
      "programmes",
      "classes",
      "subjects",
      "curriculum",
    ].includes(t)
  ) return "courses";

  // Rooms / hotel / stay
  if (
    [
      "rooms",
      "room types",
      "accommodation",
      "suites",
      "stay options",
    ].includes(t)
  ) return "rooms";

  // Delivery / shipping
  if (
    [
      "delivery",
      "shipping",
      "delivery areas",
      "shipping details",
      "delivery policy",
    ].includes(t)
  ) return "delivery";

  if (["mixed"].includes(t)) return "mixed";

  return t || "other";
}

function prettySectionName(section) {
  const map = {
    faqs: "FAQs",
    hours: "Business Hours",
    offers: "Services / Offers / Pricing",
    menu: "Menu",
    products: "Products / Catalog",
    listings: "Listings / Properties",
    paymentPlans: "Payment Plans",
    booking: "Bookings / Appointments",
    policies: "Policies",
    contact: "Contact Information",
    profile: "Business Profile",
    team: "Team / Staff",
    courses: "Courses / Programs",
    rooms: "Rooms / Accommodation",
    delivery: "Delivery / Shipping",
    other: "Other Information",
    mixed: "Mixed Content",
  };
  return map[section] || section;
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
  push("About Us", data.about);
  push("Working Hours", data.hours);

  push("Phone / WhatsApp", data.phoneWhatsapp);
  push("Email", data.email);
  push("Address / Location", data.address);

  push("Services", data.services);
  push("Pricing / Packages", data.pricing);

  push("Menu", data.menu);
  push("Products", data.products);
  push("Listings", data.listingsSummary);
  push("Payment Plans", data.paymentPlans);

  push("Bookings / Appointments", data.booking);
  push("Doctors / Staff / Team", data.team);
  push("Courses / Programs", data.courses);
  push("Rooms / Accommodation", data.rooms);
  push("Delivery / Shipping", data.delivery);

  push("Policies", data.policies);
  push("FAQs", data.faqs);

  return normalizeText(lines.join("\n"));
}

function splitMixedToSections(mixedText = "") {
  const text = normalizeText(mixedText);
  if (!text) return {};

  const mapTitleToSection = (title) => {
    const t = String(title || "").toLowerCase().trim();

    if (t.includes("faq") || t.includes("question")) return "faqs";

    if (
      t.includes("working hours") ||
      t === "hours" ||
      t.includes("open") ||
      t.includes("schedule") ||
      t.includes("timing") ||
      t.includes("availability")
    ) return "hours";

    if (
      t.includes("service") ||
      t.includes("offer") ||
      t.includes("pricing") ||
      t.includes("price") ||
      t.includes("fees") ||
      t.includes("package") ||
      t.includes("treatment")
    ) return "offers";

    if (
      t.includes("menu") ||
      t.includes("food") ||
      t.includes("drink") ||
      t.includes("menu items")
    ) return "menu";

    if (
      t.includes("product") ||
      t.includes("catalog") ||
      t.includes("shop") ||
      t.includes("collection") ||
      t.includes("category")
    ) return "products";

    if (
      t.includes("listing") ||
      t.includes("properties") ||
      t.includes("inventory") ||
      t.includes("units") ||
      t.includes("apartment") ||
      t.includes("villa")
    ) return "listings";

    if (
      t.includes("payment") ||
      t.includes("installment") ||
      t.includes("plan") ||
      t.includes("finance")
    ) return "paymentPlans";

    if (
      t.includes("booking") ||
      t.includes("appointment") ||
      t.includes("reservation")
    ) return "booking";

    if (
      t.includes("policy") ||
      t.includes("policies") ||
      t.includes("rules") ||
      t.includes("refund") ||
      t.includes("return") ||
      t.includes("exchange") ||
      t.includes("cancellation") ||
      t.includes("privacy") ||
      t.includes("shipping") ||
      t.includes("warranty")
    ) return "policies";

    if (
      t.includes("phone") ||
      t.includes("whatsapp") ||
      t.includes("contact") ||
      t.includes("address") ||
      t.includes("location") ||
      t.includes("email") ||
      t.includes("branch")
    ) return "contact";

    if (
      t.includes("business name") ||
      t.includes("business type") ||
      t.includes("city") ||
      t.includes("about") ||
      t.includes("profile") ||
      t.includes("about us") ||
      t.includes("areas served")
    ) return "profile";

    if (
      t.includes("team") ||
      t.includes("staff") ||
      t.includes("doctor") ||
      t.includes("doctors") ||
      t.includes("specialist") ||
      t.includes("trainer") ||
      t.includes("teacher") ||
      t.includes("instructor")
    ) return "team";

    if (
      t.includes("course") ||
      t.includes("courses") ||
      t.includes("program") ||
      t.includes("class") ||
      t.includes("curriculum")
    ) return "courses";

    if (
      t.includes("room") ||
      t.includes("rooms") ||
      t.includes("accommodation") ||
      t.includes("suite")
    ) return "rooms";

    if (
      t.includes("delivery") ||
      t.includes("shipping")
    ) return "delivery";

    return "other";
  };

  const lines = text.split("\n");
  const out = {};
  let current = null;
  let currentTitle = null;
  let sawHeading = false;

  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);

    if (m) {
      sawHeading = true;
      currentTitle = m[1].trim();
      current = mapTitleToSection(currentTitle);
      out[current] ||= [];
      out[current].push(`## ${currentTitle}`);
      continue;
    }

    if (current) {
      out[current].push(line);
    }
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

  const common = ["offers", "hours", "faqs", "policies", "profile", "contact", "other"];

  const templates = {
    restaurant: ["menu", "offers", "hours", "faqs", "booking", "contact", "profile", "policies", "delivery", "other"],
    cafe: ["menu", "offers", "hours", "faqs", "booking", "contact", "profile", "policies", "delivery", "other"],
    bakery: ["menu", "products", "hours", "faqs", "contact", "profile", "policies", "delivery", "other"],

    realestate: ["listings", "paymentPlans", "offers", "hours", "faqs", "policies", "profile", "contact", "other"],

    clinic: ["offers", "team", "booking", "hours", "faqs", "policies", "profile", "contact", "other"],
    dental: ["offers", "team", "booking", "hours", "faqs", "policies", "profile", "contact", "other"],
    hospital: ["offers", "team", "booking", "hours", "faqs", "policies", "profile", "contact", "other"],

    salon: ["offers", "booking", "hours", "faqs", "team", "policies", "profile", "contact", "other"],
    spa: ["offers", "booking", "hours", "faqs", "team", "policies", "profile", "contact", "other"],
    gym: ["offers", "team", "hours", "faqs", "policies", "profile", "contact", "other"],

    ecommerce: ["products", "offers", "delivery", "faqs", "policies", "contact", "profile", "other"],
    retail: ["products", "offers", "delivery", "faqs", "policies", "contact", "profile", "other"],
    pharmacy: ["products", "hours", "delivery", "faqs", "policies", "contact", "profile", "other"],

    hotel: ["rooms", "booking", "offers", "hours", "faqs", "policies", "profile", "contact", "other"],
    hostel: ["rooms", "booking", "offers", "hours", "faqs", "policies", "profile", "contact", "other"],

    education: ["courses", "offers", "hours", "faqs", "team", "policies", "profile", "contact", "other"],
    academy: ["courses", "offers", "hours", "faqs", "team", "policies", "profile", "contact", "other"],
    school: ["courses", "hours", "faqs", "team", "policies", "profile", "contact", "other"],

    automotive: ["products", "offers", "hours", "faqs", "policies", "profile", "contact", "other"],
    showroom: ["products", "offers", "hours", "faqs", "policies", "profile", "contact", "other"],

    default: common,
  };

  return templates[bt] || common;
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
  client.systemPrompt = "";
}

function detectSectionsFromClient(client, botType) {
  const base = new Set(chooseSections(botType));

  for (const f of client.files || []) {
    const name = canonicalSectionName(f.name);
    if (name && name !== "mixed") base.add(name);
  }

  base.add("other");

  return Array.from(base);
}

function buildCoverageWarnings({ expectedSections, presentSections }) {
  const missingSections = expectedSections.filter((s) => !presentSections.includes(s));
  const coverageWarnings = [];

  if (missingSections.length > 0) {
    coverageWarnings.push(
      `Missing sections: ${missingSections.map(prettySectionName).join(", ")}`
    );
  }

  if (expectedSections.includes("listings") && !presentSections.includes("listings")) {
    coverageWarnings.push("No listings detected.");
  }
  if (expectedSections.includes("paymentPlans") && !presentSections.includes("paymentPlans")) {
    coverageWarnings.push("No payment plans detected.");
  }
  if (expectedSections.includes("faqs") && !presentSections.includes("faqs")) {
    coverageWarnings.push("No FAQs detected.");
  }

  return { missingSections, coverageWarnings };
}

function buildNextAction({ hasChunks, missingSections }) {
  if (!hasChunks) return "Add business information and rebuild the bot.";
  if (missingSections.includes("listings")) return "Upload listings data and rebuild.";
  if (missingSections.includes("paymentPlans")) return "Add payment plans and rebuild.";
  if (missingSections.includes("faqs")) return "Add FAQs to improve customer answers.";
  if (missingSections.includes("hours")) return "Add business hours so customers can ask about opening times.";
  if (missingSections.includes("contact")) return "Add contact information so customers can reach the business easily.";
  return "Bot is ready to answer customer messages.";
}

function buildUiSummary({
  knowledgeStatus,
  inserted,
  presentSections,
  missingSections,
  completeness,
  nextAction,
}) {
  return {
    statusLabel:
      knowledgeStatus === "ready"
        ? "Ready"
        : knowledgeStatus === "needs_review"
        ? "Needs Review"
        : knowledgeStatus === "empty"
        ? "Empty"
        : "Building",
    insertedChunks: inserted,
    detectedSections: presentSections.map(prettySectionName),
    missingSections: missingSections.map(prettySectionName),
    completeness,
    nextAction,
  };
}

function mergePromptConfig(oldConfig = {}, newConfig = {}) {
  return {
    ...oldConfig,
    ...newConfig,
    humanEscalation: {
      ...(oldConfig?.humanEscalation || {}),
      ...(newConfig?.humanEscalation || {}),
    },
    orderFlow: {
      ...(oldConfig?.orderFlow || {}),
      ...(newConfig?.orderFlow || {}),
    },
  };
}

/* ---------------------------
   NEW: Build one merged systemPrompt
---------------------------- */
function buildSystemPromptFromClientFiles(client, botType = "default") {
  const allFiles = Array.isArray(client.files) ? client.files : [];
  if (!allFiles.length) return "";

  const nonMixed = allFiles.filter((f) => canonicalSectionName(f?.name) !== "mixed");
  const filesToUse = nonMixed.length ? nonMixed : allFiles;

  const preferredOrder = [
    "profile",
    "contact",
    "hours",
    "offers",
    "menu",
    "products",
    "listings",
    "paymentPlans",
    "booking",
    "team",
    "courses",
    "rooms",
    "delivery",
    "policies",
    "faqs",
    "other",
  ];

  const expected = chooseSections(botType);
  const order = [...new Set([...preferredOrder, ...expected, ...filesToUse.map((f) => canonicalSectionName(f?.name))])];

  const bySection = new Map();
  for (const file of filesToUse) {
    const section = canonicalSectionName(file?.name || "other");
    const text = normalizeText(file?.content || "");
    if (!text) continue;

    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(text);
  }

  const blocks = [];
  for (const section of order) {
    const items = bySection.get(section) || [];
    if (!items.length) continue;

    const merged = normalizeText(items.join("\n\n"));
    if (!merged) continue;

    blocks.push(`## ${prettySectionName(section)}\n${merged}`);
  }

  return normalizeText(blocks.join("\n\n"));
}

async function rebuildKnowledge({ clientId, botType = "default", replace = false }) {
  const client = await Client.findOne({ clientId });
  if (!client) return { ok: false, status: 404, error: "Client not found" };

  await Client.updateOne({ clientId }, { $set: { knowledgeStatus: "building" } });

  if (replace) {
    await KnowledgeChunk.deleteMany({ clientId });
  } else {
    await KnowledgeChunk.deleteMany({ clientId, botType });
  }

  const mixedFile = (client.files || []).find((f) => String(f.name || "").toLowerCase() === "mixed");
  if (mixedFile?.content) {
    const parts = splitMixedToSections(mixedFile.content);
    for (const [section, text] of Object.entries(parts)) {
      if (text) await upsertClientFile(client, section, text, "mixed-split");
    }
  }

  // NEW: always refresh full merged prompt from current saved files
  client.systemPrompt = buildSystemPromptFromClientFiles(client, botType);

  await client.save();

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
  const sectionsOrder = expectedSections.filter((s) => presentSections.includes(s));
  const completeness = expectedSections.length
    ? Math.round((presentSections.length / expectedSections.length) * 100)
    : 0;

  const { missingSections, coverageWarnings } = buildCoverageWarnings({
    expectedSections,
    presentSections,
  });

  let finalStatus = "empty";
  if (hasChunks && coverageWarnings.length === 0) finalStatus = "ready";
  if (hasChunks && coverageWarnings.length > 0) finalStatus = "needs_review";

  const nextAction = buildNextAction({ hasChunks, missingSections });
  const uiSummary = buildUiSummary({
    knowledgeStatus: finalStatus,
    inserted: docs.length,
    presentSections,
    missingSections,
    completeness,
    nextAction,
  });

  await Client.updateOne(
    { clientId },
    {
      $set: {
        botBuilt: hasChunks,
        knowledgeStatus: finalStatus,
        knowledgeBotType: botType,
        knowledgeBuiltAt: new Date(),
        sectionsPresent: presentSections,
        sectionsOrder,
        coverageWarnings,
        completeness,
        nextAction,
        systemPrompt: client.systemPrompt || "",
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
    sectionsOrder,
    coverageWarnings,
    completeness,
    nextAction,
    uiSummary,
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

    const sectionsPresent = Array.isArray(client.sectionsPresent) ? client.sectionsPresent : [];
    const sectionsOrder = Array.isArray(client.sectionsOrder) ? client.sectionsOrder : [];
    const coverageWarnings = Array.isArray(client.coverageWarnings) ? client.coverageWarnings : [];
    const completeness = Number(client.completeness || 0) || 0;
    const nextAction = String(client.nextAction || "").trim() || "Add business information and rebuild the bot.";

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
      sectionsPresent,
      sectionsOrder,
      coverageWarnings,
      completeness,
      nextAction,
      uiSummary: {
        statusLabel:
          status === "ready"
            ? "Ready"
            : status === "needs_review"
            ? "Needs Review"
            : status === "empty"
            ? "Empty"
            : "Building",
        insertedChunks: count,
        detectedSections: sectionsPresent.map(prettySectionName),
        missingSections: [],
        completeness,
        nextAction,
      },
    });
  } catch (err) {
    console.error("❌ /api/knowledge/status error:", err);
    return res.status(500).json({ ok: false, error: "Status failed" });
  }
});

router.post("/build", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId, inputType, botType, replace, promptConfig } = req.body || {};
    if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    const doReplace = Boolean(replace);

    if (doReplace) resetClientKnowledgeSources(client);

    // Save promptConfig so dynamic prompt changes per client
    if (promptConfig && typeof promptConfig === "object") {
      client.promptConfig = mergePromptConfig(client.promptConfig || {}, promptConfig);
    }

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

    // NEW: save incoming data into systemPrompt immediately too
    client.systemPrompt = buildSystemPromptFromClientFiles(client, botType || "default");

    await client.save();

    const built = await rebuildKnowledge({ clientId, botType: botType || "default", replace: doReplace });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({
      ok: true,
      savedAs: fileName,
      message: built.nextAction,
      build: built,
      promptConfigSaved: Boolean(promptConfig && typeof promptConfig === "object"),
      systemPromptUpdated: true,
    });
  } catch (err) {
    console.error("❌ /api/knowledge/build error:", err);
    return res.status(500).json({ ok: false, error: "Build failed" });
  }
});

router.post("/upload", verifyToken, upload.single("file"), requireClientOwnership, async (req, res) => {
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

    if (!mimetype.includes("text") && !isTxt) {
      return res.status(400).json({ ok: false, error: "Only .txt supported." });
    }

    const content = normalizeText(req.file.buffer.toString("utf8"));
    if (!content) return res.status(400).json({ ok: false, error: "Empty file." });

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    if (replace) resetClientKnowledgeSources(client);

    await upsertClientFile(client, section, content, replace ? "bot-upload-replace" : "bot-upload");

    // NEW: save incoming upload into systemPrompt immediately too
    client.systemPrompt = buildSystemPromptFromClientFiles(client, botType);

    await client.save();

    const built = await rebuildKnowledge({ clientId, botType, replace });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({
      ok: true,
      savedAs: section,
      message: built.nextAction,
      build: built,
      systemPromptUpdated: true,
    });
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

    const built = await rebuildKnowledge({ clientId, botType, replace });
    if (!built.ok) return res.status(built.status || 500).json(built);

    return res.json({
      ...built,
      message: built.nextAction,
      systemPromptUpdated: true,
    });
  } catch (err) {
    console.error("❌ /api/knowledge/rebuild error:", err);
    return res.status(500).json({ ok: false, error: "Rebuild failed" });
  }
});

export default router;