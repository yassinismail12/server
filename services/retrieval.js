// services/retrieval.js — FINAL VERSION
// Includes: query rewriting, intent-based section targeting,
// numerical filter boosting, full-coverage fallback,
// and dynamic per-client Arabic expansion (zero manual updates per niche).

import Client from "../Client.js";
import KnowledgeChunk from "../KnowledgeChunk.js";
import { rewriteQuery, applyFiltersToChunks } from "./queryRewriter.js";
import { getMergedExpansionMap, expandTokensWithMap } from "../utils/arabicExpander.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function safeText(value = "") {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function joinBlocks(...parts) {
  return parts.map(safeText).filter(Boolean).join("\n\n").trim();
}

export function detectUserLanguage(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || "")) ? "ar" : "en";
}

function normalizeSearchText(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text = "") {
  return normalizeSearchText(text)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length > 1);
}

function uniqueTokens(tokens = []) {
  return [...new Set(tokens)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk scoring — uses dynamic expansion map (covers all niches)
// ─────────────────────────────────────────────────────────────────────────────
function scoreChunkAgainstQuery(chunk = {}, query = "", expansionMap = {}) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const rawTokens = uniqueTokens(tokenize(normalizedQuery));
  if (!rawTokens.length) return 0;

  // Use dynamic map — covers base Arabic + client-specific niche vocabulary
  const queryTokens = expandTokensWithMap(rawTokens, expansionMap);

  const section = normalizeSearchText(chunk.section || "");
  const text = normalizeSearchText(chunk.text || "");
  const body = `${section} ${text}`.trim();
  const arabicKeywordsText = normalizeSearchText(
    (chunk.arabicKeywords || []).join(" ")
  );

  if (!body) return 0;

  let score = 0;

  for (const token of queryTokens) {
    if (!token) continue;
    if (text.includes(token)) score += 2;
    if (section.includes(token)) score += 3;
    if (arabicKeywordsText.includes(token)) score += 3;
  }

  if (body.includes(normalizedQuery)) score += 8;

  // Section-specific boosts
  const SECTION_BOOSTS = [
    { tokens: ["price", "pricing", "cost", "fee", "fees", "cheapest", "budget"], section: "offers", boost: 3 },
    { tokens: ["menu", "food", "drink", "meal", "beverage"], section: "menu", boost: 4 },
    { tokens: ["property", "unit", "apartment", "villa", "listing", "bedroom"], section: "listings", boost: 4 },
    { tokens: ["installment", "payment", "plan", "downpayment", "finance"], section: "paymentPlans", boost: 4 },
    { tokens: ["hour", "hours", "open", "opening", "schedule", "time", "closing"], section: "hours", boost: 4 },
    { tokens: ["phone", "call", "whatsapp", "address", "location", "email", "contact"], section: "contact", boost: 4 },
    { tokens: ["delivery", "shipping", "deliver", "area"], section: "delivery", boost: 4 },
    { tokens: ["booking", "reservation", "appointment", "book", "reserve"], section: "booking", boost: 4 },
    { tokens: ["product", "catalog", "shop", "item", "sku"], section: "products", boost: 4 },
    { tokens: ["doctor", "specialist", "team", "staff", "physician"], section: "team", boost: 3 },
    { tokens: ["course", "class", "program", "certificate", "curriculum"], section: "courses", boost: 3 },
    { tokens: ["room", "suite", "accommodation", "night", "stay"], section: "rooms", boost: 3 },
    { tokens: ["policy", "policies", "refund", "return", "cancellation"], section: "policies", boost: 3 },
    { tokens: ["faq", "question", "frequently", "asked"], section: "faqs", boost: 3 },
  ];

  for (const { tokens, section: sec, boost } of SECTION_BOOSTS) {
    if (queryTokens.some((t) => tokens.includes(t)) && chunk.section === sec) {
      score += boost;
    }
  }

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback prompt builder
// ─────────────────────────────────────────────────────────────────────────────
function buildFallbackPromptFromClient(client = {}) {
  const promptConfig = client.promptConfig || {};
  const business = client.businessData || client.business || {};
  const get = (...keys) => {
    for (const k of keys) {
      const v = safeText(business[k] || client[k] || promptConfig[k]);
      if (v) return v;
    }
    return "";
  };

  const lines = [
    "BUSINESS KNOWLEDGE",
    get("businessName") ? `Business Name: ${get("businessName")}` : null,
    get("businessType") ? `Business Type: ${get("businessType")}` : null,
    get("city") ? `City: ${get("city")}` : null,
    get("area") ? `Area: ${get("area")}` : null,
    get("address") ? `Address: ${get("address")}` : null,
    get("location") ? `Location: ${get("location")}` : null,
    get("phone") ? `Phone: ${get("phone")}` : null,
    get("whatsapp") ? `WhatsApp: ${get("whatsapp")}` : null,
    get("email") ? `Email: ${get("email")}` : null,
    get("hours", "workingHours") ? `Working Hours: ${get("hours", "workingHours")}` : null,
    get("services") ? `Services: ${get("services")}` : null,
    get("pricing") ? `Pricing: ${get("pricing")}` : null,
    get("menu") ? `Menu: ${get("menu")}` : null,
    get("delivery") ? `Delivery: ${get("delivery")}` : null,
    get("policies") ? `Policies: ${get("policies")}` : null,
    get("faqs") ? `FAQs: ${get("faqs")}` : null,
  ].filter(Boolean).join("\n").trim();

  return joinBlocks(safeText(client.systemPrompt), lines);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grounding rules
// ─────────────────────────────────────────────────────────────────────────────
function buildGroundingRules(userLanguage = "en") {
  return [
    "GENERAL RULES",
    "- Reply in natural plain text only.",
    "- Reply as the business representative in a natural way.",
    "- Use only the provided retrieved business knowledge for business facts.",
    "- Never invent products, services, prices, offers, policies, opening hours, availability, addresses, contact details, payment plans, listings, or business facts.",
    "- If the requested information is not clearly available in the provided knowledge, say that you do not have that information.",
    "- Keep replies clear, helpful, concise, and natural.",
    "",
    "LANGUAGE RULES",
    "- Always reply in the same language used by the user.",
    "- If the user writes in Egyptian colloquial Arabic (عامية مصرية), reply in Egyptian colloquial Arabic.",
    "- If the user writes in Modern Standard Arabic (فصحى), reply in Modern Standard Arabic.",
    userLanguage === "ar"
      ? "- The user wrote in Arabic. Reply in Arabic."
      : "- The user wrote in English. Reply in English.",
  ].join("\n");
}

function buildRetrievedKnowledgeBlock(retrievedChunks = []) {
  if (!retrievedChunks.length) return "";
  const lines = ["RETRIEVED BUSINESS KNOWLEDGE"];
  retrievedChunks.forEach((chunk, index) => {
    lines.push(`\nChunk ${index + 1}:`);
    if (chunk.section) lines.push(`Section: ${chunk.section}`);
    lines.push(chunk.text);
  });
  return safeText(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// DB fetch — section-targeted + $text search + recency fallback
// ─────────────────────────────────────────────────────────────────────────────
async function fetchCandidateChunks({ clientId, botType, query, sections = [], limit = 40 }) {
  const baseFilter = { clientId, botType };

  // Section-targeted fetch (high precision when rewriter identified sections)
  let sectionChunks = [];
  if (sections.length) {
    sectionChunks = await KnowledgeChunk.find({ ...baseFilter, section: { $in: sections } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  // Full-text search
  let textChunks = [];
  try {
    if (query && query.trim()) {
      textChunks = await KnowledgeChunk.find(
        { ...baseFilter, $text: { $search: query } },
        { score: { $meta: "textScore" } }
      )
        .sort({ score: { $meta: "textScore" } })
        .limit(limit)
        .lean();
    }
  } catch {
    // text index not ready — silent fallthrough
  }

  // Recency fallback
  let fallbackChunks = [];
  if (!sectionChunks.length && !textChunks.length) {
    fallbackChunks = await KnowledgeChunk.find(baseFilter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  // Merge + dedup by _id
  const seen = new Set();
  const merged = [];
  for (const row of [...sectionChunks, ...textChunks, ...fallbackChunks]) {
    const id = String(row._id);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({
      id,
      section: safeText(row.section),
      text: safeText(row.text),
      arabicKeywords: Array.isArray(row.arabicKeywords) ? row.arabicKeywords : [],
      mongoScore: row.score ?? 0,
    });
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-coverage ranking
// ─────────────────────────────────────────────────────────────────────────────
function rankWithFullCoverage({ candidates, query, filters, expansionMap, maxChunks }) {
  // Score with dynamic expansion
  let scored = candidates.map((chunk) => ({
    ...chunk,
    score: scoreChunkAgainstQuery(chunk, query, expansionMap) + (chunk.mongoScore ?? 0),
  }));

  // Boost chunks matching numerical/attribute filters
  if (filters) scored = applyFiltersToChunks(scored, filters);

  // Top relevant
  const relevant = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks);

  // Coverage top-up — 1 best chunk per uncovered section
  const coveredSections = new Set(relevant.map((c) => c.section));
  const bySectionBest = {};
  for (const chunk of scored) {
    const s = chunk.section;
    if (coveredSections.has(s)) continue;
    if (!bySectionBest[s] || chunk.score > bySectionBest[s].score) {
      bySectionBest[s] = chunk;
    }
  }

  const seen = new Set(relevant.map((c) => c.id));
  const merged = [...relevant];
  for (const chunk of Object.values(bySectionBest)) {
    if (!seen.has(chunk.id)) {
      merged.push(chunk);
      seen.add(chunk.id);
    }
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────
export async function retrieveChunks({
  clientId,
  botType = "default",
  userText,
  retrievalQuery = "",
  maxChunks = 8,
} = {}) {
  const safeClientId = safeText(clientId);
  const safeBotType = safeText(botType) || "default";
  const safeUserText = safeText(userText);
  const rawQuery = safeText(retrievalQuery) || safeUserText;

  const empty = (source) => ({
    mode: "single_prompt",
    finalSystemPrompt: "",
    userText: safeUserText,
    retrievalQuery: rawQuery,
    userLanguage: detectUserLanguage(safeUserText),
    hasPrompt: false,
    source,
    retrievedChunks: [],
  });

  if (!safeClientId) return empty("missing_client_id");

  const client = await Client.findOne({ clientId: safeClientId }).lean();
  if (!client) return empty("client_not_found");

  // ── Load merged Arabic expansion map (base + client niche, zero API call) ──
  const expansionMap = getMergedExpansionMap(client);

  const basePrompt = joinBlocks(
    safeText(client.finalSystemPrompt),
    !safeText(client.finalSystemPrompt) ? safeText(client.systemPrompt) : "",
    !safeText(client.finalSystemPrompt) && !safeText(client.systemPrompt)
      ? safeText(client.businessKnowledgePrompt) : "",
    !safeText(client.finalSystemPrompt) && !safeText(client.systemPrompt) && !safeText(client.businessKnowledgePrompt)
      ? buildFallbackPromptFromClient(client) : ""
  );

  // ── Step 1: Rewrite query — extract intent, sections, filters ───────────────
  const rewritten = await rewriteQuery(safeUserText);
  const userLanguage = rewritten.language;
  const searchQuery = rewritten.rewritten ? rewritten.expandedQuery : rawQuery;

  // ── Step 2: Fetch candidates ────────────────────────────────────────────────
  const candidates = await fetchCandidateChunks({
    clientId: safeClientId,
    botType: safeBotType,
    query: searchQuery,
    sections: rewritten.sections,
    limit: 40,
  });

  // ── Step 3: Score + filter + rank with full coverage ────────────────────────
  const retrievedChunks = rankWithFullCoverage({
    candidates,
    query: searchQuery,
    filters: rewritten.filters,
    expansionMap,
    maxChunks: Number(maxChunks) > 0 ? Number(maxChunks) : 8,
  });

  if (retrievedChunks.length) {
    const finalSystemPrompt = joinBlocks(
      buildGroundingRules(userLanguage),
      basePrompt,
      buildRetrievedKnowledgeBlock(retrievedChunks)
    );

    return {
      mode: "chunk_retrieval",
      finalSystemPrompt,
      userText: safeUserText,
      retrievalQuery: searchQuery,
      userLanguage,
      hasPrompt: Boolean(finalSystemPrompt),
      source: "knowledge_chunks",
      retrievedChunks,
      intent: rewritten.intent,
      detectedSections: rewritten.sections,
      appliedFilters: rewritten.filters,
    };
  }

  return {
    mode: "single_prompt",
    finalSystemPrompt: joinBlocks(buildGroundingRules(userLanguage), basePrompt),
    userText: safeUserText,
    retrievalQuery: searchQuery,
    userLanguage,
    hasPrompt: Boolean(basePrompt),
    source: "knowledge_chunks_no_match_fallback",
    retrievedChunks: [],
  };
}

export default retrieveChunks;