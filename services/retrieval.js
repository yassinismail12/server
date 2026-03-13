import Client from "../Client.js";
import KnowledgeChunk from "../KnowledgeChunk.js";

function safeText(value = "") {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function joinBlocks(...parts) {
  return parts.map(safeText).filter(Boolean).join("\n\n").trim();
}

function detectUserLanguage(text = "") {
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

function buildFallbackPromptFromClient(client = {}) {
  const promptConfig = client.promptConfig || {};
  const business = client.businessData || client.business || {};

  const businessName =
    safeText(business.businessName) ||
    safeText(client.businessName) ||
    safeText(promptConfig.businessName);

  const businessType =
    safeText(business.businessType) ||
    safeText(client.businessType) ||
    safeText(promptConfig.businessType);

  const city =
    safeText(business.city) ||
    safeText(client.city) ||
    safeText(promptConfig.city);

  const area =
    safeText(business.area) ||
    safeText(client.area) ||
    safeText(promptConfig.area);

  const address =
    safeText(business.address) ||
    safeText(client.address) ||
    safeText(promptConfig.address);

  const location =
    safeText(business.location) ||
    safeText(client.location) ||
    safeText(promptConfig.location);

  const phone =
    safeText(business.phone) ||
    safeText(client.phone) ||
    safeText(promptConfig.phone);

  const whatsapp =
    safeText(business.whatsapp) ||
    safeText(client.whatsapp) ||
    safeText(promptConfig.whatsapp);

  const email =
    safeText(business.email) ||
    safeText(client.email) ||
    safeText(promptConfig.email);

  const hours =
    safeText(business.hours) ||
    safeText(business.workingHours) ||
    safeText(client.hours) ||
    safeText(promptConfig.hours);

  const services =
    safeText(business.services) ||
    safeText(client.services) ||
    safeText(promptConfig.services);

  const pricing =
    safeText(business.pricing) ||
    safeText(client.pricing) ||
    safeText(promptConfig.pricing);

  const menu =
    safeText(business.menu) ||
    safeText(client.menu) ||
    safeText(promptConfig.menu);

  const delivery =
    safeText(business.delivery) ||
    safeText(client.delivery) ||
    safeText(promptConfig.delivery);

  const policies =
    safeText(business.policies) ||
    safeText(client.policies) ||
    safeText(promptConfig.policies);

  const faqs =
    safeText(business.faqs) ||
    safeText(client.faqs) ||
    safeText(promptConfig.faqs);

  const customPrompt = safeText(client.systemPrompt);

  const businessLines = [
    "BUSINESS KNOWLEDGE",
    businessName ? `Business Name: ${businessName}` : null,
    businessType ? `Business Type: ${businessType}` : null,
    city ? `City: ${city}` : null,
    area ? `Area: ${area}` : null,
    address ? `Address: ${address}` : null,
    location ? `Location: ${location}` : null,
    phone ? `Phone: ${phone}` : null,
    whatsapp ? `WhatsApp: ${whatsapp}` : null,
    email ? `Email: ${email}` : null,
    hours ? `Working Hours: ${hours}` : null,
    services ? `Services: ${services}` : null,
    pricing ? `Pricing: ${pricing}` : null,
    menu ? `Menu: ${menu}` : null,
    delivery ? `Delivery: ${delivery}` : null,
    policies ? `Policies: ${policies}` : null,
    faqs ? `FAQs: ${faqs}` : null,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  return joinBlocks(customPrompt, businessLines);
}

function scoreChunkAgainstQuery(chunk = {}, query = "") {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const queryTokens = uniqueTokens(tokenize(normalizedQuery));
  if (!queryTokens.length) return 0;

  const section = normalizeSearchText(chunk.section || "");
  const text = normalizeSearchText(chunk.text || "");
  const body = `${section} ${text}`.trim();

  if (!body) return 0;

  let score = 0;

  for (const token of queryTokens) {
    if (!token) continue;

    if (text.includes(token)) score += 2;
    if (section.includes(token)) score += 3;
  }

  if (body.includes(normalizedQuery)) score += 8;

  if (
    queryTokens.some((t) => ["price", "pricing", "cost", "fee", "fees"].includes(t)) &&
    chunk.section === "offers"
  ) {
    score += 3;
  }

  if (
    queryTokens.some((t) => ["menu", "food", "drink", "meal"].includes(t)) &&
    chunk.section === "menu"
  ) {
    score += 4;
  }

  if (
    queryTokens.some((t) => ["property", "unit", "apartment", "villa", "listing"].includes(t)) &&
    chunk.section === "listings"
  ) {
    score += 4;
  }

  if (
    queryTokens.some((t) => ["installment", "payment", "plan", "downpayment"].includes(t)) &&
    chunk.section === "paymentPlans"
  ) {
    score += 4;
  }

  if (
    queryTokens.some((t) => ["hour", "hours", "open", "opening", "schedule", "time"].includes(t)) &&
    chunk.section === "hours"
  ) {
    score += 4;
  }

  if (
    queryTokens.some((t) => ["phone", "call", "whatsapp", "address", "location", "email", "contact"].includes(t)) &&
    chunk.section === "contact"
  ) {
    score += 4;
  }

  return score;
}

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
    userLanguage === "ar"
      ? "- The user wrote in Arabic. Reply in Arabic."
      : "- The user wrote in English. Reply in English.",
  ].join("\n");
}

function buildRetrievedKnowledgeBlock(retrievedChunks = []) {
  if (!retrievedChunks.length) return "";

  const lines = ["RETRIEVED BUSINESS KNOWLEDGE"];

  retrievedChunks.forEach((chunk, index) => {
    lines.push(`Chunk ${index + 1}:`);
    if (chunk.section) lines.push(`Section: ${chunk.section}`);
    lines.push(chunk.text);
    lines.push("");
  });

  return safeText(lines.join("\n"));
}

async function fetchCandidateChunks({ clientId, botType, limit = 120 }) {
  const rows = await KnowledgeChunk.find({ clientId, botType })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return rows.map((row, index) => ({
    id: String(row._id || `chunk_${index}`),
    section: safeText(row.section),
    text: safeText(row.text),
  }));
}

export async function retrieveChunks({
  clientId,
  botType = "default",
  userText,
  retrievalQuery = "",
  maxChunks = 6,
} = {}) {
  const safeClientId = safeText(clientId);
  const safeBotType = safeText(botType) || "default";
  const safeUserText = safeText(userText);
  const safeRetrievalQuery = safeText(retrievalQuery) || safeUserText;
  const userLanguage = detectUserLanguage(safeUserText);

  if (!safeClientId) {
    return {
      mode: "single_prompt",
      finalSystemPrompt: "",
      userText: safeUserText,
      retrievalQuery: safeRetrievalQuery,
      userLanguage,
      hasPrompt: false,
      source: "missing_client_id",
      retrievedChunks: [],
    };
  }

  const client = await Client.findOne({ clientId: safeClientId }).lean();

  if (!client) {
    return {
      mode: "single_prompt",
      finalSystemPrompt: "",
      userText: safeUserText,
      retrievalQuery: safeRetrievalQuery,
      userLanguage,
      hasPrompt: false,
      source: "client_not_found",
      retrievedChunks: [],
    };
  }

  const basePrompt = joinBlocks(
    safeText(client.finalSystemPrompt),
    !safeText(client.finalSystemPrompt) ? safeText(client.systemPrompt) : "",
    !safeText(client.finalSystemPrompt) && !safeText(client.systemPrompt)
      ? safeText(client.businessKnowledgePrompt)
      : "",
    !safeText(client.finalSystemPrompt) &&
      !safeText(client.systemPrompt) &&
      !safeText(client.businessKnowledgePrompt)
      ? buildFallbackPromptFromClient(client)
      : ""
  );

  const candidateChunks = await fetchCandidateChunks({
    clientId: safeClientId,
    botType: safeBotType,
    limit: 120,
  });

  const retrievedChunks = candidateChunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunkAgainstQuery(chunk, safeRetrievalQuery),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(maxChunks) > 0 ? Number(maxChunks) : 6);

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
      retrievalQuery: safeRetrievalQuery,
      userLanguage,
      hasPrompt: Boolean(finalSystemPrompt),
      source: "knowledge_chunks",
      retrievedChunks,
    };
  }

  return {
    mode: "single_prompt",
    finalSystemPrompt: joinBlocks(buildGroundingRules(userLanguage), basePrompt),
    userText: safeUserText,
    retrievalQuery: safeRetrievalQuery,
    userLanguage,
    hasPrompt: Boolean(basePrompt),
    source: "knowledge_chunks_no_match_fallback",
    retrievedChunks: [],
  };
}

export default retrieveChunks;
