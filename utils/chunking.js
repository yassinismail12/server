// utils/chunking.js

function splitByBlankBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bundle(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(items.slice(i, i + n).join("\n\n"));
  }
  return out;
}

function prettySectionTitle(sectionName = "") {
  const key = String(sectionName || "").trim();

  const map = {
    profile: "PROFILE",
    contact: "CONTACT",
    hours: "HOURS",
    offers: "SERVICES / OFFERS",
    faqs: "FAQS",
    listings: "LISTINGS",
    paymentPlans: "PAYMENT PLANS",
    policies: "POLICIES",
    menu: "MENU",
    other: "OTHER INFORMATION",
    mixed: "MIXED CONTENT",
  };

  return map[key] || String(key || "INFORMATION").replace(/_/g, " ").toUpperCase();
}

function withSectionTitle(sectionName, chunks) {
  const title = prettySectionTitle(sectionName);

  return (chunks || [])
    .map((chunk) => String(chunk || "").trim())
    .filter(Boolean)
    .map((chunk) => `${title}\n\n${chunk}`);
}

// ✅ Universal chunker that works for any business type.
// Priority: delimiter (---) → blank blocks → headings/bullets → size fallback
function genericChunk(text) {
  const t = String(text || "").trim();
  if (!t) return [];

  // 1) Strong delimiter split (recommended UX tip: use --- between items)
  let parts = t
    .split(/\n-{3,}\n/)
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

  let chunks = [];

  switch (sectionName) {
    case "listings": {
      // 1) delimiter/blank/headings/size
      let listings = genericChunk(t);

      // 2) If still one block, try a light “record heading” split
      if (listings.length <= 1) {
        listings = t
          .split(/(?=property\s*\d*:|unit\s*\d*:|listing\s*\d*:|project:|compound:)/i)
          .map((s) => s.trim())
          .filter(Boolean);

        if (listings.length <= 1) listings = genericChunk(t);
      }

      chunks = listings;
      break;
    }

    case "paymentPlans": {
      const blocks = splitByBlankBlocks(t);
      chunks = blocks.length <= 1 ? genericChunk(t) : bundle(blocks, 3);
      break;
    }

    case "faqs": {
      const faqs = splitByBlankBlocks(t);
      chunks = faqs.length <= 1 ? genericChunk(t) : bundle(faqs, 8);
      break;
    }

    default: {
      chunks = genericChunk(t);
      break;
    }
  }

  return withSectionTitle(sectionName, chunks);
}