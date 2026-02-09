export function splitByBlankBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n+/)     // split on blank lines
    .map(s => s.trim())
    .filter(Boolean);
}

export function splitByLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Use lines for menus, blank-blocks for FAQs/listings/offers
export function chunkSection(sectionName, text) {
  const t = String(text || "").trim();
  if (!t) return [];

  if (sectionName === "menu") return splitByLines(t);
  if (sectionName === "hours") return [t]; // keep as one chunk
  return splitByBlankBlocks(t);
}
