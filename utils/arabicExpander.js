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
  "تقسيط": ["installment", "payment plan"],
  "مقدم": ["down payment", "deposit"],
  "كاش": ["cash"],
  "فيزا": ["card", "visa"],
  // Contact
  "تليفون": ["phone", "contact"],
  "رقم": ["phone number", "contact"],
  "واتساب": ["whatsapp", "contact"],
  "واتس": ["whatsapp"],
  "ايميل": ["email"],
  "عنوان": ["address", "location"],
  "موقع": ["location", "address"],
  // Hours
  "مواعيد": ["hours", "schedule", "availability"],
  "ساعات": ["hours", "opening times"],
  "بتفتح": ["opening time", "open"],
  "بتقفل": ["closing time", "closed"],
  "مفتوح": ["open"],
  "مغلق": ["closed"],
  // Booking
  "حجز": ["booking", "reservation", "appointment"],
  "احجز": ["book", "reserve"],
  "موعد": ["appointment", "schedule"],
  // Delivery
  "توصيل": ["delivery", "shipping"],
  "شحن": ["shipping"],
  "بيوصلوا": ["deliver to", "delivery available"],
  // Food/Menu
  "منيو": ["menu", "food", "drinks"],
  "الاكل": ["food", "menu"],
  "وجبة": ["meal"],
  "مشروبات": ["drinks", "beverages"],
  "قهوة": ["coffee"],
  "شاي": ["tea"],
  "عصير": ["juice"],
  // Real estate
  "شقة": ["apartment", "unit"],
  "شقق": ["apartments", "units"],
  "فيلا": ["villa"],
  "وحدة": ["unit", "property"],
  "عقار": ["property", "real estate"],
  "غرف": ["bedrooms", "rooms"],
  "اوضة": ["bedroom", "room"],
  // Medical
  "دكتور": ["doctor", "specialist"],
  "عيادة": ["clinic"],
  "كشف": ["consultation", "checkup"],
  "علاج": ["treatment"],
  // Education
  "كورس": ["course", "class", "program"],
  "شهادة": ["certificate", "diploma"],
  "مدرس": ["teacher", "instructor"],
  // Automotive
  "سيارة": ["car", "vehicle"],
  "موديل": ["model"],
  "اوتوماتيك": ["automatic"],
  "مانيوال": ["manual"],
  // Hotel
  "فندق": ["hotel", "accommodation"],
  "ليلة": ["night", "overnight stay"],
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
 * Drop-in replacement for the static expandArabicTokens in retrieval.js
 *
 * @param {string[]} tokens
 * @param {object} expansionMap - from getMergedExpansionMap()
 * @returns {string[]} expanded unique tokens
 */
export function expandTokensWithMap(tokens = [], expansionMap = {}) {
  const expanded = [];
  for (const token of tokens) {
    expanded.push(token);
    if (expansionMap[token]) {
      expanded.push(...expansionMap[token]);
      continue;
    }
    // Fuzzy: strip Arabic prefixes
    const stripped = token.replace(/^(ال|وال|بال|فال|لل|ول|بل|فل|و|ب|ف|ل)/, "");
    if (stripped !== token && expansionMap[stripped]) {
      expanded.push(...expansionMap[stripped]);
    }
    // Fuzzy: add ال prefix
    const withAl = "ال" + token;
    if (expansionMap[withAl]) {
      expanded.push(...expansionMap[withAl]);
    }
  }
  return [...new Set(expanded)];
}