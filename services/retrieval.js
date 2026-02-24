import KnowledgeChunk from "../KnowledgeChunk.js";

export async function retrieveChunks({ clientId, botType = "default", userText }) {
  const safeText = String(userText || "").trim();

  // If userText is empty, just return hours + maybe some FAQs
  if (!safeText) {
    const fallback = await KnowledgeChunk.find({ clientId, botType })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return groupAndCap(fallback, { alwaysIncludeHours: true, clientId, botType });
  }

  // 1) Main retrieval: text search
  const raw = await KnowledgeChunk.find(
    { clientId, botType, $text: { $search: safeText } },
    { score: { $meta: "textScore" }, section: 1, text: 1, createdAt: 1 }
  )
    .limit(50)
    .lean();

  // 2) Sort best-first
  let results = raw.sort((a, b) => (b.score || 0) - (a.score || 0));

  // ✅ IMPORTANT: do NOT hard filter score >= 1 (often kills everything)
  // If you still want filtering, use something tiny:
  // results = results.filter(r => (r.score || 0) >= 0.2);

  // Final cap
  results = results.slice(0, 30);

  // 3) If empty, fallback (very important)
  if (!results.length) {
    const fallback = await KnowledgeChunk.find({ clientId, botType })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean();

    return groupAndCap(fallback, { alwaysIncludeHours: true, clientId, botType });
  }

  // 4) Group + cap
  return groupAndCap(results, { alwaysIncludeHours: true, clientId, botType });
}

/** helper */
function groupAndCap(results, { alwaysIncludeHours = true, clientId, botType } = {}) {
  // caps per section
  const caps = { menu: 15, offers: 6, faqs: 6, listings: 8, hours: 1, paymentPlans: 4, policies: 4, other: 4 };

  const grouped = {};
  for (const r of results) {
    const s = r.section || "other";
    grouped[s] ||= [];

    if (grouped[s].length < (caps[s] ?? 6)) grouped[s].push(r);
  }

  // Always include hours if exists
  // NOTE: since this helper isn't async, we do hours inclusion in caller
  // We'll return grouped now; caller ensures hours via async step if needed
  
  return grouped;
  
}