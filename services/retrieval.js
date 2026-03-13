import Client from "../Client.js";
import KnowledgeChunk from "../KnowledgeChunk.js";

// ─────────────────────────────────────────────────────────────────────────────
// ARABIC ↔ ENGLISH KEYWORD MAP
// Maps Arabic / Egyptian-dialect tokens → English section keywords
// Used by scoreChunkAgainstQuery so Arabic queries hit English chunks.
// Add more entries here anytime you need to support new vocabulary.
// ─────────────────────────────────────────────────────────────────────────────
export const ARABIC_TO_ENGLISH_KEYWORDS = {
  // ── Menu / Food ──────────────────────────────────────────────────────────
  "المنيو":        ["menu", "food", "meal", "drink"],
  "منيو":          ["menu", "food", "meal", "drink"],
  "الاكل":         ["menu", "food", "meal"],
  "اكل":           ["menu", "food", "meal"],
  "الأكل":         ["menu", "food", "meal"],
  "أكل":           ["menu", "food", "meal"],
  "وجبة":          ["meal", "menu", "food"],
  "وجبات":         ["meal", "menu", "food"],
  "الوجبات":       ["meal", "menu", "food"],
  "مشروبات":       ["drinks", "menu", "beverages"],
  "المشروبات":     ["drinks", "menu", "beverages"],
  "مشروب":         ["drink", "menu", "beverage"],
  "عصير":          ["juice", "drinks", "menu"],
  "قهوة":          ["coffee", "drinks", "menu"],
  "شاي":           ["tea", "drinks", "menu"],

  // ── Pricing / Offers ─────────────────────────────────────────────────────
  "السعر":         ["price", "pricing", "cost", "fee"],
  "سعر":           ["price", "pricing", "cost", "fee"],
  "الأسعار":       ["price", "pricing", "cost", "fees"],
  "أسعار":         ["price", "pricing", "cost", "fees"],
  "اسعار":         ["price", "pricing", "cost", "fees"],
  "الاسعار":       ["price", "pricing", "cost", "fees"],
  "تكلفة":         ["cost", "price", "fee"],
  "التكلفة":       ["cost", "price", "fee"],
  "عروض":          ["offers", "deals", "discount", "pricing"],
  "العروض":        ["offers", "deals", "discount", "pricing"],
  "خصم":           ["discount", "offers", "deals"],
  "الخصم":         ["discount", "offers", "deals"],
  "خصومات":        ["discount", "offers", "deals"],
  "اوفر":          ["offers", "deals", "discount"],
  "اوفرات":        ["offers", "deals", "discount"],
  "بكام":          ["price", "pricing", "cost", "fee"],
  "بكد":           ["price", "pricing", "cost", "fee"],

  // ── Hours / Timing ────────────────────────────────────────────────────────
  "المواعيد":      ["hours", "schedule", "opening", "time"],
  "مواعيد":        ["hours", "schedule", "opening", "time"],
  "الوقت":         ["time", "hours", "schedule"],
  "وقت":           ["time", "hours", "schedule"],
  "ساعات":         ["hours", "schedule", "opening"],
  "الساعات":       ["hours", "schedule", "opening"],
  "بتفتح":         ["hours", "opening", "schedule"],
  "بتقفل":         ["hours", "closing", "schedule"],
  "فاتح":          ["hours", "opening", "open"],
  "مفتوح":         ["hours", "opening", "open"],
  "قافل":          ["hours", "closing", "closed"],
  "مغلق":          ["hours", "closing", "closed"],
  "امتى":          ["hours", "time", "schedule", "when"],
  "امتي":          ["hours", "time", "schedule", "when"],

  // ── Location / Address ────────────────────────────────────────────────────
  "العنوان":       ["address", "location", "contact"],
  "عنوان":         ["address", "location", "contact"],
  "فين":           ["address", "location", "contact", "where"],
  "فيه":           ["location", "address"],
  "المكان":        ["location", "address"],
  "مكان":          ["location", "address"],
  "الموقع":        ["location", "address", "map"],
  "موقع":          ["location", "address", "map"],
  "منين":          ["address", "location", "where"],

  // ── Contact ───────────────────────────────────────────────────────────────
  "تليفون":        ["phone", "call", "contact"],
  "التليفون":      ["phone", "call", "contact"],
  "رقم":           ["phone", "contact", "number"],
  "الرقم":         ["phone", "contact", "number"],
  "واتساب":        ["whatsapp", "contact", "phone"],
  "واتس":          ["whatsapp", "contact", "phone"],
  "تواصل":         ["contact", "phone", "whatsapp"],
  "كلمونا":        ["contact", "phone", "call"],
  "ايميل":         ["email", "contact"],
  "الايميل":       ["email", "contact"],

  // ── Delivery ──────────────────────────────────────────────────────────────
  "توصيل":         ["delivery", "shipping"],
  "التوصيل":       ["delivery", "shipping"],
  "شحن":           ["shipping", "delivery"],
  "الشحن":         ["shipping", "delivery"],
  "بيوصلوا":       ["delivery", "shipping"],
  "هيوصل":         ["delivery", "shipping"],

  // ── Booking / Reservation ─────────────────────────────────────────────────
  "حجز":           ["booking", "reservation", "appointment"],
  "الحجز":         ["booking", "reservation", "appointment"],
  "احجز":          ["booking", "reservation"],
  "حجزات":         ["booking", "reservation"],
  "موعد":          ["appointment", "booking", "schedule"],
  "المواعيد":      ["appointment", "booking", "schedule"],
  "ريزيرفيشن":     ["reservation", "booking"],

  // ── Payment / Installments ────────────────────────────────────────────────
  "دفع":           ["payment", "pay", "installment"],
  "الدفع":         ["payment", "pay", "installment"],
  "تقسيط":         ["installment", "payment", "plan"],
  "التقسيط":       ["installment", "payment", "plan"],
  "مقدم":          ["downpayment", "installment", "payment"],
  "كاش":           ["cash", "payment"],
  "كريدت":         ["credit", "card", "payment"],
  "فيزا":          ["visa", "card", "payment"],

  // ── Services / Products ────────────────────────────────────────────────────
  "خدمات":         ["services", "products"],
  "الخدمات":       ["services", "products"],
  "خدمة":          ["service"],
  "منتجات":        ["products", "services"],
  "المنتجات":      ["products", "services"],
  "منتج":          ["product"],

  // ── Real estate ───────────────────────────────────────────────────────────
  "شقة":           ["apartment", "unit", "listing", "property"],
  "شقق":           ["apartments", "units", "listings", "property"],
  "فيلا":          ["villa", "property", "listing"],
  "فيلات":         ["villas", "properties", "listings"],
  "وحدة":          ["unit", "apartment", "listing"],
  "وحدات":         ["units", "apartments", "listings"],
  "عقار":          ["property", "real estate", "listing"],
  "العقار":        ["property", "real estate", "listing"],

  // ── General intent ────────────────────────────────────────────────────────
  "عايز":          ["want", "need", "looking"],
  "عاوز":          ["want", "need", "looking"],
  "أريد":          ["want", "need"],
  "اريد":          ["want", "need"],
  "محتاج":         ["need", "want"],
  "ممكن":          ["can", "possible", "available"],
  "فيه":           ["available", "have", "is there"],
  "في":            ["available", "have", "is there"],
  "عندكم":         ["have", "available", "do you have"],
  "عندكوا":        ["have", "available", "do you have"],
  "بتعملوا":       ["do you", "service", "offer"],
  "بيعملوا":       ["do they", "service", "offer"],
  "ايه":           ["what", "which"],
  "إيه":           ["what", "which"],
  "معلومات":       ["information", "details", "info"],
  "تفاصيل":        ["details", "information", "info"],
};

// ─────────────────────────────────────────────────────────────────────────────
// ARABIC SECTION KEYWORDS
// Used at chunk-save time: given a section name, what Arabic keywords
// should be stored in arabicKeywords[] so retrieval works in Arabic?
// Import this in your dataset processing route.
// ─────────────────────────────────────────────────────────────────────────────
export const ARABIC_SECTION_KEYWORDS = {
  menu:          ["منيو", "المنيو", "الاكل", "وجبات", "مشروبات"],
  offers:        ["عروض", "العروض", "خصم", "خصومات", "اسعار"],
  pricing:       ["سعر", "اسعار", "الاسعار", "تكلفة", "بكام"],
  hours:         ["مواعيد", "المواعيد", "ساعات", "بتفتح", "بتقفل", "امتى"],
  contact:       ["رقم", "تليفون", "واتساب", "تواصل", "ايميل"],
  location:      ["عنوان", "فين", "موقع", "المكان"],
  delivery:      ["توصيل", "شحن", "بيوصلوا"],
  booking:       ["حجز", "احجز", "موعد", "ريزيرفيشن"],
  paymentPlans:  ["تقسيط", "دفع", "مقدم", "كاش"],
  services:      ["خدمات", "خدمة", "بتعملوا"],
  products:      ["منتجات", "منتج"],
  listings:      ["شقة", "شقق", "فيلا", "وحدة", "عقار"],
  faqs:          ["سؤال", "اسئلة", "استفسار"],
};

// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// expandArabicTokens
// Takes the raw Arabic tokens from the user message and expands them to include
// their English equivalents using ARABIC_TO_ENGLISH_KEYWORDS.
// Example: ["عايز", "المنيو"] → ["عايز", "want", "need", "looking", "المنيو", "menu", "food", "meal", "drink"]
// ─────────────────────────────────────────────────────────────────────────────
function expandArabicTokens(tokens = []) {
  const expanded = [];

  for (const token of tokens) {
    expanded.push(token); // always keep original

    // Direct lookup
    if (ARABIC_TO_ENGLISH_KEYWORDS[token]) {
      expanded.push(...ARABIC_TO_ENGLISH_KEYWORDS[token]);
      continue;
    }

    // Fuzzy: try stripping common Arabic prefixes (ال، و، ب، ف، ل)
    const stripped = token.replace(/^(ال|وال|بال|فال|لل|ول|بل|فل|و|ب|ف|ل)/, "");
    if (stripped !== token && ARABIC_TO_ENGLISH_KEYWORDS[stripped]) {
      expanded.push(...ARABIC_TO_ENGLISH_KEYWORDS[stripped]);
    }

    // Fuzzy: try with ال prefix added
    const withAl = "ال" + token;
    if (ARABIC_TO_ENGLISH_KEYWORDS[withAl]) {
      expanded.push(...ARABIC_TO_ENGLISH_KEYWORDS[withAl]);
    }
  }

  return uniqueTokens(expanded);
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
    city        ? `City: ${city}` : null,
    area        ? `Area: ${area}` : null,
    address     ? `Address: ${address}` : null,
    location    ? `Location: ${location}` : null,
    phone       ? `Phone: ${phone}` : null,
    whatsapp    ? `WhatsApp: ${whatsapp}` : null,
    email       ? `Email: ${email}` : null,
    hours       ? `Working Hours: ${hours}` : null,
    services    ? `Services: ${services}` : null,
    pricing     ? `Pricing: ${pricing}` : null,
    menu        ? `Menu: ${menu}` : null,
    delivery    ? `Delivery: ${delivery}` : null,
    policies    ? `Policies: ${policies}` : null,
    faqs        ? `FAQs: ${faqs}` : null,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  return joinBlocks(customPrompt, businessLines);
}

// ─────────────────────────────────────────────────────────────────────────────
// scoreChunkAgainstQuery — now fully Arabic/English bilingual
// ─────────────────────────────────────────────────────────────────────────────
function scoreChunkAgainstQuery(chunk = {}, query = "") {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const rawTokens     = uniqueTokens(tokenize(normalizedQuery));
  if (!rawTokens.length) return 0;

  // ✅ Expand Arabic tokens to English equivalents
  const queryTokens = expandArabicTokens(rawTokens);

  const section = normalizeSearchText(chunk.section || "");
  const text    = normalizeSearchText(chunk.text    || "");
  const body    = `${section} ${text}`.trim();

  // ✅ Also score against the chunk's arabicKeywords if present
  const arabicKeywordsText = normalizeSearchText(
    (chunk.arabicKeywords || []).join(" ")
  );

  if (!body) return 0;

  let score = 0;

  for (const token of queryTokens) {
    if (!token) continue;

    if (text.includes(token))              score += 2;
    if (section.includes(token))           score += 3;
    if (arabicKeywordsText.includes(token)) score += 3; // ✅ Arabic keyword match
  }

  if (body.includes(normalizedQuery))       score += 8;

  // ── Section-specific boosts ───────────────────────────────────────────────
  if (
    queryTokens.some((t) => ["price", "pricing", "cost", "fee", "fees", "بكام", "اسعار", "سعر"].includes(t)) &&
    chunk.section === "offers"
  ) score += 3;

  if (
    queryTokens.some((t) => ["menu", "food", "drink", "meal", "منيو", "اكل", "وجبات", "مشروبات"].includes(t)) &&
    chunk.section === "menu"
  ) score += 4;

  if (
    queryTokens.some((t) => ["property", "unit", "apartment", "villa", "listing", "شقة", "فيلا", "وحدة", "عقار"].includes(t)) &&
    chunk.section === "listings"
  ) score += 4;

  if (
    queryTokens.some((t) => ["installment", "payment", "plan", "downpayment", "تقسيط", "مقدم", "دفع"].includes(t)) &&
    chunk.section === "paymentPlans"
  ) score += 4;

  if (
    queryTokens.some((t) => ["hour", "hours", "open", "opening", "schedule", "time", "مواعيد", "بتفتح", "ساعات", "امتى"].includes(t)) &&
    chunk.section === "hours"
  ) score += 4;

  if (
    queryTokens.some((t) => ["phone", "call", "whatsapp", "address", "location", "email", "contact", "رقم", "واتساب", "تليفون", "عنوان", "فين"].includes(t)) &&
    chunk.section === "contact"
  ) score += 4;

  if (
    queryTokens.some((t) => ["delivery", "shipping", "توصيل", "شحن", "بيوصلوا"].includes(t)) &&
    chunk.section === "delivery"
  ) score += 4;

  if (
    queryTokens.some((t) => ["booking", "reservation", "appointment", "حجز", "موعد", "ريزيرفيشن"].includes(t)) &&
    chunk.section === "booking"
  ) score += 4;

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
    id:              String(row._id || `chunk_${index}`),
    section:         safeText(row.section),
    text:            safeText(row.text),
    arabicKeywords:  Array.isArray(row.arabicKeywords) ? row.arabicKeywords : [], // ✅
  }));
}

export async function retrieveChunks({
  clientId,
  botType          = "default",
  userText,
  retrievalQuery   = "",
  maxChunks        = 6,
} = {}) {
  const safeClientId      = safeText(clientId);
  const safeBotType       = safeText(botType) || "default";
  const safeUserText      = safeText(userText);
  const safeRetrievalQuery = safeText(retrievalQuery) || safeUserText;
  const userLanguage      = detectUserLanguage(safeUserText);

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
    !safeText(client.finalSystemPrompt)
      ? safeText(client.systemPrompt)
      : "",
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
    botType:  safeBotType,
    limit:    120,
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