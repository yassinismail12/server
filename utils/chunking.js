// utils/chunking.js

function splitByBlankBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bundle(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n).join("\n\n"));
  return out;
}

// ✅ Universal chunker that works for any business type.
// Priority: delimiter (---) → blank blocks → headings/bullets → size fallback
function genericChunk(text) {
  const t = String(text || "").trim();
  if (!t) return [];

  // 1) Strong delimiter split (recommended UX tip: use --- between items)
  let parts = t
    .split(/\n-{3,}\n/) // --- on its own line
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  // 2) Blank blocks
  parts = splitByBlankBlocks(t);
  if (parts.length > 1) return parts;

  // 3) Headings or bullet starts
  parts = t
    .split(/\n(?=(?:#{1,3}\s+|\*\s+|-\s+|•\s+))/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  // 4) Size fallback with overlap
  const size = 1200;
  const overlap = 200;

  if (t.length <= size) return [t];

  const chunks = [];
  for (let i = 0; i < t.length; i += size - overlap) {
    chunks.push(t.slice(i, i + size).trim());
  }
  return chunks.filter(Boolean);
}

export function chunkSection(sectionName, text) {
  const t = String(text || "").trim();
  if (!t) return [];

  switch (sectionName) {
    case "listings": {
      // Keep real-estate friendly hint split, but still universal-first
      // 1) delimiter/blank/headings/size
      let listings = genericChunk(t);

      // 2) If still one block, try a light “record heading” split (won’t hurt other businesses)
      if (listings.length <= 1) {
        listings = t
          .split(/(?=property\s*\d*:|unit\s*\d*:|listing\s*\d*:|project:|compound:)/i)
          .map((s) => s.trim())
          .filter(Boolean);

        // if that didn’t help, revert to generic single chunk
        if (listings.length <= 1) listings = genericChunk(t);
      }

      return listings;
    }

    case "paymentPlans": {
      const blocks = splitByBlankBlocks(t);
      // If user wrote it as one long paragraph, fall back to generic chunking
      if (blocks.length <= 1) return genericChunk(t);
      return bundle(blocks, 3);
    }

    case "faqs": {
      const faqs = splitByBlankBlocks(t);
      // If user didn’t separate FAQs well, fall back to generic chunking
      if (faqs.length <= 1) return genericChunk(t);
      return bundle(faqs, 8);
    }

    // Generic for everything else (pharmacy, clinic, salon, etc.)
    default:
      return genericChunk(t);
  }
}