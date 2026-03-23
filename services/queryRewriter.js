// services/queryRewriter.js
// ✅ OPTIMIZATIONS:
// 1. Skip rewrite for short messages (<15 chars) — saves a full API call
// 2. In-memory cache for repeated queries — near-instant for common questions

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── In-memory cache ──────────────────────────────────────────────────────────
const rewriteCache = new Map();
const CACHE_MAX = 500;

// ─── Canonical section list ───────────────────────────────────────────────────
const ALL_SECTIONS = [
  "menu", "offers", "products", "listings", "paymentPlans",
  "hours", "contact", "delivery", "booking", "faqs",
  "policies", "team", "courses", "rooms", "profile", "other",
];

const REWRITE_SYSTEM_PROMPT = `
You are a query analysis assistant for a business chatbot.

Given a customer message, extract a JSON object with these fields:
- "intent": one short English phrase describing what the customer wants (e.g. "find cheapest menu item", "check opening hours", "book appointment")
- "sections": array of section names the answer likely lives in. Choose only from: ${ALL_SECTIONS.join(", ")}
- "filters": object of any numerical or attribute filters detected. Examples:
    { "maxPrice": 1500000, "minBedrooms": 3, "location": "New Cairo" }
    { "maxPrice": 50 }
    { "category": "desserts" }
  Use null if no filters apply.
- "expandedQuery": a clean English search phrase (3-10 words) that will be used to search the knowledge base. Translate Arabic to English. Remove filler words.
- "language": "ar" if the message is primarily Arabic (including Egyptian dialect), else "en"

Rules:
- Always return valid JSON only. No prose, no markdown, no backticks.
- "sections" must be an array of 1-3 items from the allowed list only.
- "filters" keys should be camelCase. Values should be numbers (not strings) for numeric filters.
- If no filters, set "filters" to null.
- "expandedQuery" must always be English regardless of input language.

Examples:
Input: "عايز اعرف ارخص حاجة في المنيو"
Output: {"intent":"find cheapest menu item","sections":["menu"],"filters":null,"expandedQuery":"cheapest item menu price","language":"ar"}

Input: "show me 3 bedroom apartments under 1.5 million"
Output: {"intent":"find 3 bedroom apartment under budget","sections":["listings"],"filters":{"maxBedrooms":3,"maxPrice":1500000},"expandedQuery":"3 bedroom apartment listing price","language":"en"}

Input: "ممكن احجز موعد بكره؟"
Output: {"intent":"book appointment","sections":["booking","hours"],"filters":null,"expandedQuery":"booking appointment available schedule","language":"ar"}

Input: "do you deliver to Maadi and how much does it cost?"
Output: {"intent":"delivery to area and cost","sections":["delivery","offers"],"filters":{"location":"Maadi"},"expandedQuery":"delivery area Maadi cost fee","language":"en"}
`.trim();

export async function rewriteQuery(userText) {
  const fallback = {
    intent: userText,
    sections: [],
    filters: null,
    expandedQuery: userText,
    language: /[\u0600-\u06FF]/.test(userText) ? "ar" : "en",
    rewritten: false,
  };

  if (!userText || !userText.trim()) return fallback;

  // ✅ Skip rewrite for short messages — not worth a second API call
  // "hello", "thanks", "ok", "yes", "لأ", "اوكي", "is there delivery?" etc.
  if (userText.trim().length < 20) return fallback;

  // ✅ Return cached result for repeated queries
  const cacheKey = userText.trim().toLowerCase().slice(0, 200);
  if (rewriteCache.has(cacheKey)) return rewriteCache.get(cacheKey);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        { role: "user", content: String(userText).slice(0, 500) },
      ],
      max_tokens: 200,
      temperature: 0,
    });

    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned);

    const safeSections = Array.isArray(parsed.sections)
      ? parsed.sections.filter((s) => ALL_SECTIONS.includes(s))
      : [];

    const result = {
      intent: String(parsed.intent || userText).trim(),
      sections: safeSections,
      filters: parsed.filters && typeof parsed.filters === "object" ? parsed.filters : null,
      expandedQuery: String(parsed.expandedQuery || userText).trim(),
      language: parsed.language === "ar" ? "ar" : "en",
      rewritten: true,
    };

    // Cache it — evict oldest if at capacity
    if (rewriteCache.size >= CACHE_MAX) {
      rewriteCache.delete(rewriteCache.keys().next().value);
    }
    rewriteCache.set(cacheKey, result);

    return result;
  } catch (err) {
    console.warn("⚠️ queryRewriter fallback:", err?.message);
    return fallback;
  }
}

export function applyFiltersToChunks(chunks, filters) {
  if (!filters || !chunks.length) return chunks;

  const filterEntries = Object.entries(filters);
  if (!filterEntries.length) return chunks;

  return chunks
    .map((chunk) => {
      let boost = 0;
      const text = String(chunk.text || "").toLowerCase();

      for (const [key, value] of filterEntries) {
        if (value === null || value === undefined) continue;

        const strValue = String(value).toLowerCase();

        if (typeof value === "string") {
          if (text.includes(strValue)) boost += 5;
          continue;
        }

        if (typeof value === "number") {
          const nums = [...text.matchAll(/[\d,]+(?:\.\d+)?/g)]
            .map((m) => parseFloat(m[0].replace(/,/g, "")))
            .filter((n) => !isNaN(n));

          if (!nums.length) continue;

          const keyLower = key.toLowerCase();

          if (keyLower.includes("max") && keyLower.includes("price")) {
            if (nums.some((n) => n <= value)) boost += 6;
            continue;
          }
          if (keyLower.includes("min") && keyLower.includes("price")) {
            if (nums.some((n) => n >= value)) boost += 6;
            continue;
          }
          if (keyLower.includes("bedroom")) {
            if (nums.some((n) => n === value)) boost += 8;
            continue;
          }
          if (keyLower.includes("area") || keyLower.includes("sqm")) {
            if (nums.some((n) => Math.abs(n - value) / value < 0.2)) boost += 4;
            continue;
          }
          if (nums.some((n) => n === value)) boost += 3;
        }
      }

      return { ...chunk, score: (chunk.score || 0) + boost };
    })
    .sort((a, b) => b.score - a.score);
}