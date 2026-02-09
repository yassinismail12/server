import KnowledgeChunk from "../KnowledgeChunk.js";

export async function retrieveChunks({ clientId, botType = "default", userText }) {
  const results = await KnowledgeChunk.find(
    { clientId, botType, $text: { $search: userText } },
    { score: { $meta: "textScore" }, section: 1, text: 1 }
  )
  .sort({ score: { $meta: "textScore" } })
  .limit(30)
  .lean();

  // cap per section (tune these)
  const caps = { menu: 15, offers: 6, faqs: 6, listings: 8, hours: 1 };

  const grouped = {};
  for (const r of results) {
    const s = r.section;
    grouped[s] ||= [];
    if (grouped[s].length < (caps[s] ?? 6)) grouped[s].push(r);
  }

  // always include hours if exists
  if (!grouped.hours) {
    const hours = await KnowledgeChunk.findOne({ clientId, botType, section: "hours" }).lean();
    if (hours) grouped.hours = [hours];
  }

  return grouped;
}
