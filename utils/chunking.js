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
  // Step 1: Try blank block split
  let listings = splitByBlankBlocks(t);

  // Step 2: If only 1 block, try property-based split
  if (listings.length <= 1) {
    listings = t.split(/(?=property\s*\d*:|unit\s*\d*:|listing\s*\d*:|project:|compound:)/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Step 3: Fallback by length if still single block
  if (listings.length <= 1 && t.length > 1500) {
    const size = 1200;
    const overlap = 200;
    const chunks = [];
    for (let i = 0; i < t.length; i += (size - overlap)) {
      chunks.push(t.slice(i, i + size));
    }
    return chunks;
  }

  // ✅ safest: 1 listing per chunk
  return listings;
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
