// utils/arabicExpander.js
//
// THE PERMANENT FIX FOR NEW NICHES
//
// Instead of a static keyword map that you have to manually update for every
// new client type, this module:
//
//   1. Has a large static base map (all common Egyptian Arabic vocabulary)
//   2. Automatically generates niche-specific Arabic ↔ English mappings
//      at knowledge-build time using GPT, then STORES them in the client record
//   3. At query time, loads the client's stored custom mappings and merges
//      them with the base map — zero manual work per niche
//
// This means: onboard a medical clinic, a car showroom, a law firm, a gym —
// the Arabic expansion automatically covers their domain vocabulary.

import OpenAI from "openai";
import Client from "../Client.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// DIACRITIC STRIPPING
// Strips Arabic tashkeel (diacritics) so "مَواعِيد" matches "مواعيد"
// Always run on both query tokens and chunk text before any comparison.
// ─────────────────────────────────────────────────────────────────────────────
export function stripArabicDiacritics(text = "") {
  return String(text || "").replace(/[\u0610-\u061A\u064B-\u065F\u0670]/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// BASE MAP — Egyptian Arabic common vocabulary
// This never changes. New niches are handled by the dynamic layer below.
// ─────────────────────────────────────────────────────────────────────────────
export const BASE_ARABIC_MAP = {
  // Intent
  "عايز": ["want", "need", "looking for"],
  "عاوز": ["want", "need", "looking for"],
  "اريد": ["want", "need"],
  "أريد": ["want", "need"],
  "محتاج": ["need", "require"],
  "ممكن": ["possible", "available", "can"],
  "عندكم": ["do you have", "available"],
  "فيه": ["available", "is there", "have"],
  "ايه": ["what", "which"],
  "إيه": ["what", "which"],
  "امتى": ["when", "time", "schedule"],
  "امتي": ["when", "time", "schedule"],
  "فين": ["where", "location", "address"],
  "بكام": ["price", "cost", "how much"],
  "بكد": ["price", "cost", "how much"],
  "ارخص": ["cheapest", "lowest price", "budget"],
  "اغلى": ["most expensive", "premium"],
  "احسن": ["best", "recommended"],
  "افضل": ["best", "better"],
  "كلها": ["all", "every", "list of"],
  "قائمة": ["list", "all"],
  "كل": ["all", "every"],
  "تفاصيل": ["details", "information"],
  "معلومات": ["information", "details"],
  "مثلا": ["for example", "such as"],
  "زي": ["like", "similar to"],

  // Pricing
  "سعر": ["price", "cost", "fee"],
  "السعر": ["price", "cost", "fee"],
  "اسعار": ["prices", "costs", "fees"],
  "الاسعار": ["prices", "costs", "fees"],
  "تكلفة": ["cost", "fee"],
  "خصم": ["discount", "offer"],
  "عروض": ["offers", "deals", "discounts"],
  "عرض": ["offer", "deal", "discount"],
  "تقسيط": ["installment", "payment plan"],
  "مقدم": ["down payment", "deposit"],
  "كاش": ["cash"],
  "فيزا": ["card", "visa"],

  // Contact
  "تليفون": ["phone", "contact"],
  "تلفون": ["phone", "contact"],
  "رقم": ["phone number", "contact"],
  "واتساب": ["whatsapp", "contact"],
  "واتس": ["whatsapp"],
  "ايميل": ["email"],
  "عنوان": ["address", "location"],
  "موقع": ["location", "address"],

  // Hours — section boost bridge: these map to "hours" section boost tokens
  "مواعيد": ["hours", "schedule", "availability", "open", "opening"],
  "ساعات": ["hours", "opening times", "open"],
  "بتفتح": ["opening time", "open", "hours"],
  "بتقفل": ["closing time", "closed", "hours"],
  "مفتوح": ["open", "hours"],
  "مغلق": ["closed", "hours"],
  "الدوام": ["hours", "working hours", "schedule"],
  "وقت الفتح": ["opening time", "open", "hours"],
  "وقت الاغلاق": ["closing time", "closed", "hours"],

  // Booking — section boost bridge
  "حجز": ["booking", "reservation", "appointment"],
  "احجز": ["book", "reserve", "booking"],
  "موعد": ["appointment", "schedule", "booking"],
  "حجزت": ["booking", "reservation"],
  "احجزلي": ["book", "reserve"],

  // Delivery — section boost bridge
  "توصيل": ["delivery", "shipping", "deliver"],
  "شحن": ["shipping", "delivery"],
  "بيوصلوا": ["deliver to", "delivery available", "delivery"],
  "هيوصل": ["delivery", "deliver"],
  "ايه المناطق": ["delivery area", "area", "delivery"],

  // Menu / Food — section boost bridge
  "منيو": ["menu", "food", "drinks"],
  "الاكل": ["food", "menu", "meal"],
  "وجبة": ["meal", "menu", "food"],
  "مشروبات": ["drinks", "beverages", "menu"],
  "قهوة": ["coffee", "menu"],
  "شاي": ["tea", "menu"],
  "عصير": ["juice", "drinks", "menu"],
  "اكل": ["food", "meal", "menu"],

  // Offers — section boost bridge
  "عروض النهارده": ["offers", "deals", "discounts"],
  "اخر عروض": ["offers", "latest deals", "discounts"],
  "فيه خصم": ["discount", "offer", "deals"],

  // Real estate — section boost bridge
  "شقة": ["apartment", "unit", "property"],
  "شقق": ["apartments", "units", "listings"],
  "فيلا": ["villa", "property", "listings"],
  "وحدة": ["unit", "property", "listings"],
  "عقار": ["property", "real estate", "listings"],
  "غرف": ["bedrooms", "rooms"],
  "اوضة": ["bedroom", "room"],
  "دور": ["floor", "level"],
  "مساحة": ["area", "size", "sqm"],
  "تشطيب": ["finishing", "fit out"],

  // Payment plans — section boost bridge
  "تقسيط": ["installment", "payment", "plan", "payment plan"],
  "مقدم": ["down payment", "deposit", "downpayment"],
  "اقساط": ["installments", "payment plan"],
  "دفعة": ["payment", "installment"],

  // Medical — section boost bridge
  "دكتور": ["doctor", "specialist", "team"],
  "دكاترة": ["doctors", "specialists", "team"],
  "عيادة": ["clinic"],
  "كشف": ["consultation", "checkup", "appointment", "booking"],
  "علاج": ["treatment", "therapy"],
  "حجز دكتور": ["doctor appointment", "booking", "appointment"],

  // Education — section boost bridge
  "كورس": ["course", "class", "program", "courses"],
  "كورسات": ["courses", "classes", "programs"],
  "شهادة": ["certificate", "diploma", "courses"],
  "مدرس": ["teacher", "instructor", "team"],
  "مواد": ["subjects", "curriculum", "courses"],

  // Automotive — section boost bridge
  "سيارة": ["car", "vehicle", "listings"],
  "سيارات": ["cars", "vehicles", "listings"],
  "موديل": ["model"],
  "اوتوماتيك": ["automatic"],
  "مانيوال": ["manual"],
  "ماكينة": ["engine"],
  "كيلو": ["mileage", "km"],

  // Hotel — section boost bridge
  "فندق": ["hotel", "accommodation", "rooms"],
  "غرفة": ["room", "suite", "rooms"],
  "ليلة": ["night", "overnight stay", "rooms"],
  "اقامة": ["stay", "accommodation", "rooms"],

  // Products/Shop — section boost bridge
  "منتج": ["product", "item", "products"],
  "منتجات": ["products", "items", "catalog"],
  "بضاعة": ["products", "goods", "catalog"],
  "سلعة": ["product", "item"],

  // Policies — section boost bridge
  "سياسة": ["policy", "policies"],
  "استرجاع": ["return", "refund", "policies"],
  "ارجاع": ["return", "refund", "policies"],
  "استبدال": ["exchange", "policies"],
  "ضمان": ["warranty", "guarantee", "policies"],

  // FAQs — section boost bridge
  "سؤال": ["question", "faq"],
  "اسئلة": ["questions", "faq", "frequently asked"],
  "استفسار": ["inquiry", "question", "faq"],
};

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-WORD PHRASE MAP
// Arabic phrases that should be matched as a whole before tokenizing.
// Add common patterns your customers use here.
// ─────────────────────────────────────────────────────────────────────────────
export const ARABIC_PHRASE_MAP = {
  "بكام ده": ["price", "cost", "how much"],
  "ايه السعر": ["price", "cost", "how much"],
  "إيه السعر": ["price", "cost", "how much"],
  "كام سعره": ["price", "cost"],
  "فيه توصيل": ["delivery", "deliver", "shipping"],
  "بيوصلوا عندي": ["delivery", "deliver to", "delivery area"],
  "امتى بتفتح": ["opening time", "open", "hours"],
  "امتى بتقفل": ["closing time", "closed", "hours"],
  "مواعيد العمل": ["working hours", "hours", "schedule"],
  "ايه المواعيد": ["hours", "schedule", "opening"],
  "إيه المواعيد": ["hours", "schedule", "opening"],
  "عايز احجز": ["book", "booking", "reservation", "appointment"],
  "عاوز احجز": ["book", "booking", "reservation"],
  "ممكن احجز": ["book", "booking", "reservation"],
  "عندكم عروض": ["offers", "deals", "discounts"],
  "فيه عروض": ["offers", "deals", "discounts"],
  "ايه العروض": ["offers", "deals"],
  "احسن سعر": ["best price", "cheapest", "price"],
  "ارخص سعر": ["cheapest", "lowest price", "budget"],
};

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC EXPANSION — runs once at knowledge-build time per client
//
// Reads the client's actual chunk content, detects domain vocabulary,
// and generates Arabic ↔ English mappings specific to their niche.
// Result is stored in client.arabicExpansionMap in MongoDB.
// ─────────────────────────────────────────────────────────────────────────────

const EXPANSION_SYSTEM_PROMPT = `
You are an Arabic-English vocabulary mapper for a business chatbot.

Given a sample of business knowledge text (in English), generate a JSON object
mapping Egyptian Arabic / Arabic customer vocabulary to English search terms.

Rules:
- Focus on domain-specific words a customer would type in Arabic when asking about this business
- Egyptian colloquial Arabic (عامية مصرية) is the priority
- Keys are Arabic words/phrases, values are arrays of English equivalents
- Only include terms relevant to this specific business type
- Return 15-30 mappings maximum
- Return valid JSON only, no prose, no backticks

Example output for a medical clinic:
{
  "دكتور": ["doctor", "physician", "specialist"],
  "كشف": ["consultation", "checkup", "appointment"],
  "علاج": ["treatment", "therapy", "procedure"],
  "تخصص": ["specialty", "department"],
  "مواعيد الدكاترة": ["doctors schedule", "doctor availability"],
  "نتيجة تحليل": ["test result", "lab result"],
  "اشعة": ["x-ray", "scan", "imaging"],
  "جراحة": ["surgery", "operation"],
  "طوارئ": ["emergency"],
  "تامين": ["insurance", "coverage"]
}
`.trim();

/**
 * Generates a niche-specific Arabic expansion map from the client's
 * actual knowledge content. Runs at build time only.
 *
 * @param {string} clientId
 * @param {string[]} sampleTexts - array of chunk texts from the client's KB
 * @returns {Promise<object>} arabicExpansionMap
 */
export async function generateNicheExpansionMap(clientId, sampleTexts = []) {
  if (!sampleTexts.length) return {};

  // Feed a representative sample — first 2000 chars of combined chunks
  const sample = sampleTexts
    .slice(0, 20)
    .join("\n\n")
    .slice(0, 2000);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXPANSION_SYSTEM_PROMPT },
        { role: "user", content: `Business knowledge sample:\n\n${sample}` },
      ],
      max_tokens: 600,
      temperature: 0,
    });

    const raw = completion.choices[0].message.content.trim()
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(raw);

    if (typeof parsed !== "object" || Array.isArray(parsed)) return {};

    // Validate: every value must be array of strings
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && Array.isArray(v) && v.every((s) => typeof s === "string")) {
        clean[k] = v;
      }
    }

    // Persist to client record so we never pay for this again
    await Client.updateOne(
      { clientId },
      { $set: { arabicExpansionMap: clean, arabicExpansionBuiltAt: new Date() } }
    );

    console.log(`✅ Arabic expansion map generated for ${clientId}: ${Object.keys(clean).length} terms`);
    return clean;

  } catch (err) {
    console.warn(`⚠️ Arabic expansion generation failed for ${clientId}:`, err?.message);
    return {};
  }
}

/**
 * Returns the merged Arabic expansion map for a client at query time.
 * Merges: base map + client-specific niche map (from DB).
 * Zero API calls at query time.
 *
 * @param {object} client - client document from MongoDB
 * @returns {object} merged map
 */
export function getMergedExpansionMap(client = {}) {
  const nicheMap = client.arabicExpansionMap || {};
  // Client-specific terms override base terms (more specific = more accurate)
  return { ...BASE_ARABIC_MAP, ...nicheMap };
}

/**
 * Expands Arabic query tokens using the merged map.
 * Now includes:
 *   - diacritic stripping on both query and map keys
 *   - multi-word phrase matching before tokenizing
 *   - prefix stripping (ال، و، ب etc.)
 *   - ال prefix addition fallback
 *
 * @param {string[]} tokens - already tokenized query tokens
 * @param {object} expansionMap - from getMergedExpansionMap()
 * @returns {string[]} expanded unique tokens
 */
export function expandTokensWithMap(tokens = [], expansionMap = {}) {
  const expanded = [];

  // Pre-normalize map keys once for diacritic-insensitive matching
  const normalizedMapEntries = Object.entries(expansionMap).map(([k, v]) => [
    stripArabicDiacritics(k),
    v,
  ]);

  function lookupToken(token) {
    const stripped = stripArabicDiacritics(token);

    // Direct match (diacritic-stripped)
    for (const [key, vals] of normalizedMapEntries) {
      if (key === stripped) return vals;
    }

    // Strip Arabic prefixes and try again
    const noPrefix = stripped.replace(/^(ال|وال|بال|فال|لل|ول|بل|فل|و|ب|ف|ل)/, "");
    if (noPrefix !== stripped) {
      for (const [key, vals] of normalizedMapEntries) {
        if (key === noPrefix) return vals;
      }
    }

    // Try adding ال prefix
    const withAl = "ال" + stripped;
    for (const [key, vals] of normalizedMapEntries) {
      if (key === withAl) return vals;
    }

    return null;
  }

  for (const token of tokens) {
    expanded.push(token);
    const result = lookupToken(token);
    if (result) expanded.push(...result);
  }

  return [...new Set(expanded)];
}

/**
 * Extracts multi-word phrase expansions from raw query text.
 * Call this BEFORE tokenizing — returns extra English tokens
 * to inject into the query.
 *
 * @param {string} rawQuery
 * @param {object} phraseMap - defaults to ARABIC_PHRASE_MAP
 * @returns {string[]} additional English tokens from phrase matches
 */
export function expandPhrasesFromQuery(rawQuery = "", phraseMap = ARABIC_PHRASE_MAP) {
  const normalized = stripArabicDiacritics(String(rawQuery || "").trim());
  const extra = [];

  for (const [phrase, expansions] of Object.entries(phraseMap)) {
    const normalizedPhrase = stripArabicDiacritics(phrase);
    if (normalized.includes(normalizedPhrase)) {
      extra.push(...expansions);
    }
  }

  return [...new Set(extra)];
}