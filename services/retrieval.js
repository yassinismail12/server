// services/retrieval.js
import KnowledgeChunk from "../KnowledgeChunk.js";

function normalizeText(x) {
  return String(x || "").trim();
}

export async function retrieveChunks({ clientId, botType = "default", userText }) {
  const query = normalizeText(userText);
  if (!clientId || !query) return {};

  const raw = await KnowledgeChunk.find(
    { clientId, botType, $text: { $search: query } },
    { score: { $meta: "textScore" }, section: 1, text: 1 }
  )
    .limit(50)
    .lean();

  // ✅ Guarantee best-first ordering
  const results = raw
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    // ✅ Optional: drop low-quality matches (tune threshold)
    .filter((r) => (r.score || 0) >= 1)
    // ✅ final limit
    .slice(0, 30);

  // cap per section (tune these)
  const caps = { menu: 15, offers: 6, faqs: 6, listings: 8, hours: 1 };

  const grouped = {};
  for (const r of results) {
    const s = r.section || "other";
    grouped[s] ||= [];
    if (grouped[s].length < (caps[s] ?? 6)) grouped[s].push(r);
  }

  // ✅ Always include hours if exists
  if (!grouped.hours) {
    const hours = await KnowledgeChunk.findOne({ clientId, botType, section: "hours" }).lean();
    if (hours) grouped.hours = [hours];
  }

  return grouped;
}
