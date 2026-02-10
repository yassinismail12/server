import KnowledgeChunk from "../KnowledgeChunk.js";

export async function retrieveChunks({ clientId, botType = "default", userText }) {
  const raw = await KnowledgeChunk.find(
    { clientId, botType, $text: { $search: userText } },
    { score: { $meta: "textScore" }, section: 1, text: 1 }
  )
    // NOTE: some setups are ambiguous with $meta sorting direction.
    // We'll guarantee order with a JS sort after.
    .limit(50)
    .lean();

  // ✅ Guarantee best-first ordering
  const results = raw
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    // ✅ Optional: drop low-quality matches (tune threshold)
    .filter(r => (r.score || 0) >= 1)
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

  // ✅ Always include hours if exists (good)
  if (!grouped.hours) {
    const hours = await KnowledgeChunk.findOne({ clientId, botType, section: "hours" }).lean();
    if (hours) grouped.hours = [hours];
  }

  return grouped;
}
