function splitByBlankBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function bundle(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n).join("\n\n"));
  return out;
}

export function chunkSection(sectionName, text) {
  const t = String(text || "").trim();
  if (!t) return [];

  switch (sectionName) {
    case "listings": {
      const listings = splitByBlankBlocks(t);     // ✅ 1 listing = 1 block
      return bundle(listings, 8);                 // ✅ 8 listings per chunk
    }
    case "paymentPlans": {
      const blocks = splitByBlankBlocks(t);
      return bundle(blocks, 3);
    }
    case "faqs": {
      const faqs = splitByBlankBlocks(t);
      return bundle(faqs, 8);
    }
    default:
      return [t];
  }
}
