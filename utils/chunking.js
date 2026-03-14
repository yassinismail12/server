// utils/chunking.js
// ─────────────────────────────────────────────────────────────────────────────
// Rules:
//  • Never strip Arabic characters during normalisation
//  • Never split a table mid-row — keep table blocks whole
//  • Always include section title header in every chunk
//  • Use overlap on large free-text so context bleeds across chunk boundaries
//  • Short content (< 600 chars) stays as a single chunk — no splitting
// ─────────────────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

// ─── Table detection & protection ────────────────────────────────────────────
// Detects pipe-separated tables (Markdown-style) or | col | col | rows.
// Keeps the entire table as a single chunk so no row is ever split.
function extractTableBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let tableLines = [];
  let inTable = false;

  for (const line of lines) {
    const isTableRow = /^\s*\|/.test(line) || /\|/.test(line);
    if (isTableRow) {
      inTable = true;
      tableLines.push(line);
    } else {
      if (inTable) {
        blocks.push({ type: "table", content: tableLines.join("\n") });
        tableLines = [];
        inTable = false;
      }
      blocks.push({ type: "text", content: line });
    }
  }
  if (tableLines.length) blocks.push({ type: "table", content: tableLines.join("\n") });

  // Merge consecutive text blocks back
  const merged = [];
  let textAcc = [];
  for (const block of blocks) {
    if (block.type === "text") {
      textAcc.push(block.content);
    } else {
      if (textAcc.length) {
        const t = textAcc.join("\n").trim();
        if (t) merged.push({ type: "text", content: t });
        textAcc = [];
      }
      merged.push(block);
    }
  }
  if (textAcc.length) {
    const t = textAcc.join("\n").trim();
    if (t) merged.push({ type: "text", content: t });
  }
  return merged;
}

// ─── Core splitters ───────────────────────────────────────────────────────────
function splitByBlankBlocks(text) {
  return normalizeText(text)
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitByMarkdownHeadings(text) {
  return normalizeText(text)
    .split(/\n(?=#{1,6}\s+)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitByBullets(text) {
  return normalizeText(text)
    .split(/\n(?=(?:\*\s+|-\s+|•\s+|\d+\.\s+))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitByCommonRecordStarts(text, patterns = []) {
  if (!patterns.length) return [normalizeText(text)];
  const regex = new RegExp(`(?=${patterns.join("|")})`, "i");
  return normalizeText(text)
    .split(regex)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Size-based chunking WITH overlap ────────────────────────────────────────
// overlap = 150 chars means each chunk starts 150 chars before the previous
// one ended, so no sentence is ever orphaned at a boundary.
function sizeChunk(text, size = 1200, overlap = 150) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length <= size) return [t];

  const chunks = [];
  const step = Math.max(1, size - overlap);

  for (let i = 0; i < t.length; i += step) {
    const piece = t.slice(i, i + size).trim();
    if (piece) chunks.push(piece);
    // Stop if the last chunk already covers the end
    if (i + size >= t.length) break;
  }

  return chunks;
}

// ─── Bundle small items into groups ──────────────────────────────────────────
function bundle(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(items.slice(i, i + n).join("\n\n"));
  }
  return out;
}

// ─── Section title map ────────────────────────────────────────────────────────
function prettySectionTitle(sectionName = "") {
  const key = String(sectionName || "").trim();
  const map = {
    profile: "BUSINESS PROFILE",
    contact: "CONTACT INFORMATION",
    hours: "BUSINESS HOURS",
    offers: "SERVICES / OFFERS / PRICING",
    faqs: "FAQS",
    listings: "LISTINGS / PROPERTIES",
    paymentPlans: "PAYMENT PLANS",
    policies: "POLICIES",
    menu: "MENU",
    products: "PRODUCTS / CATALOG",
    booking: "BOOKINGS / APPOINTMENTS",
    team: "TEAM / STAFF",
    courses: "COURSES / PROGRAMS",
    rooms: "ROOMS / ACCOMMODATION",
    delivery: "DELIVERY / SHIPPING",
    other: "OTHER INFORMATION",
    mixed: "MIXED CONTENT",
  };
  return map[key] || String(key || "INFORMATION").replace(/_/g, " ").toUpperCase();
}

function withSectionTitle(sectionName, chunks) {
  const title = prettySectionTitle(sectionName);
  return (chunks || [])
    .map((chunk) => normalizeText(chunk))
    .filter(Boolean)
    .map((chunk) => `${title}\n\n${chunk}`);
}

// ─── Generic chunker (handles tables safely) ─────────────────────────────────
function genericChunk(text) {
  const t = normalizeText(text);
  if (!t) return [];

  // Short content: keep whole, no splitting
  if (t.length < 600) return [t];

  // Check for tables — extract and protect them
  const blocks = extractTableBlocks(t);
  const hasTables = blocks.some((b) => b.type === "table");

  if (hasTables) {
    // Each table block stays whole; text blocks get normal chunking
    const result = [];
    for (const block of blocks) {
      if (block.type === "table") {
        result.push(block.content);
      } else {
        result.push(...genericChunkText(block.content));
      }
    }
    return result.filter(Boolean);
  }

  return genericChunkText(t);
}

function genericChunkText(text) {
  const t = normalizeText(text);
  if (!t || t.length < 600) return t ? [t] : [];

  // --- delimiter
  let parts = t.split(/\n-{3,}\n/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts;

  // blank blocks
  parts = splitByBlankBlocks(t);
  if (parts.length > 1) return parts;

  // markdown headings
  parts = splitByMarkdownHeadings(t);
  if (parts.length > 1) return parts;

  // bullets
  parts = splitByBullets(t);
  if (parts.length > 1) return parts;

  // size fallback with overlap
  return sizeChunk(t, 1200, 150);
}

// ─── Section-specific chunkers ────────────────────────────────────────────────

function chunkFaqs(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 6);

  const headingSplit = splitByMarkdownHeadings(t);
  if (headingSplit.length > 1) return bundle(headingSplit, 6);

  return genericChunk(t);
}

function chunkListings(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  // Each listing/unit should be its own chunk for accurate retrieval
  let chunks = splitByCommonRecordStarts(t, [
    "property\\s*\\d*\\s*:",
    "unit\\s*\\d*\\s*:",
    "listing\\s*\\d*\\s*:",
    "project\\s*:",
    "compound\\s*:",
    "apartment\\s*\\d*\\s*:",
    "villa\\s*\\d*\\s*:",
    "townhouse\\s*\\d*\\s*:",
    "studio\\s*\\d*\\s*:",
  ]);
  if (chunks.length > 1) return chunks;

  chunks = genericChunk(t);
  if (chunks.length > 1) return chunks;

  return sizeChunk(t, 1400, 180);
}

function chunkMenu(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  // Check for tables (common in menus)
  const blocks = extractTableBlocks(t);
  if (blocks.some((b) => b.type === "table")) {
    const result = [];
    for (const block of blocks) {
      if (block.type === "table") {
        result.push(block.content); // whole table = 1 chunk
      } else if (block.content.trim()) {
        result.push(...genericChunkText(block.content));
      }
    }
    return result.filter(Boolean);
  }

  // Category-level split (each category = 1 chunk so "main courses" stays together)
  let chunks = t
    .split(/(?=\n?(?:category\s*:|section\s*:|##\s+|breakfast|lunch|dinner|drinks|desserts|appetizers|main\s+courses|starters|sides|specials))/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (chunks.length > 1) return chunks;

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 10);

  const blankBlocks = splitByBlankBlocks(t);
  if (blankBlocks.length > 1) return bundle(blankBlocks, 5);

  return genericChunk(t);
}

function chunkProducts(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  // Tables (product catalogs are often tables)
  const blocks = extractTableBlocks(t);
  if (blocks.some((b) => b.type === "table")) {
    const result = [];
    for (const block of blocks) {
      if (block.type === "table") result.push(block.content);
      else if (block.content.trim()) result.push(...genericChunkText(block.content));
    }
    return result.filter(Boolean);
  }

  let chunks = splitByCommonRecordStarts(t, [
    "product\\s*\\d*\\s*:",
    "item\\s*\\d*\\s*:",
    "sku\\s*:",
    "category\\s*:",
    "collection\\s*:",
    "brand\\s*:",
  ]);
  if (chunks.length > 1) return chunks;

  const blocks2 = splitByBlankBlocks(t);
  if (blocks2.length > 1) return bundle(blocks2, 5);

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 10);

  return genericChunk(t);
}

function chunkPaymentPlans(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  const blocks = extractTableBlocks(t);
  if (blocks.some((b) => b.type === "table")) {
    const result = [];
    for (const block of blocks) {
      if (block.type === "table") result.push(block.content);
      else if (block.content.trim()) result.push(...genericChunkText(block.content));
    }
    return result.filter(Boolean);
  }

  const blankBlocks = splitByBlankBlocks(t);
  if (blankBlocks.length > 1) return bundle(blankBlocks, 3);

  const headingSplit = splitByMarkdownHeadings(t);
  if (headingSplit.length > 1) return bundle(headingSplit, 3);

  return genericChunk(t);
}

function chunkBooking(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 8);

  return genericChunk(t);
}

function chunkTeam(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  // Each team member = its own chunk
  let chunks = splitByCommonRecordStarts(t, [
    "doctor\\s*\\d*\\s*:",
    "dr\\.\\s+",
    "staff\\s*\\d*\\s*:",
    "team member\\s*\\d*\\s*:",
    "trainer\\s*\\d*\\s*:",
    "teacher\\s*\\d*\\s*:",
    "instructor\\s*\\d*\\s*:",
    "specialist\\s*\\d*\\s*:",
  ]);
  if (chunks.length > 1) return chunks;

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  return genericChunk(t);
}

function chunkCourses(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  let chunks = splitByCommonRecordStarts(t, [
    "course\\s*\\d*\\s*:",
    "program\\s*\\d*\\s*:",
    "class\\s*\\d*\\s*:",
    "module\\s*\\d*\\s*:",
    "track\\s*\\d*\\s*:",
  ]);
  if (chunks.length > 1) return chunks;

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  return genericChunk(t);
}

function chunkRooms(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  let chunks = splitByCommonRecordStarts(t, [
    "room\\s*\\d*\\s*:",
    "suite\\s*\\d*\\s*:",
    "accommodation\\s*:",
    "room type\\s*:",
  ]);
  if (chunks.length > 1) return chunks;

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  return genericChunk(t);
}

function chunkDelivery(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 8);

  return genericChunk(t);
}

function chunkPolicies(text) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length < 600) return [t];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  const headingSplit = splitByMarkdownHeadings(t);
  if (headingSplit.length > 1) return bundle(headingSplit, 4);

  return genericChunk(t);
}

function chunkSimpleInfo(text) {
  return genericChunk(text);
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function chunkSection(sectionName, text) {
  const section = String(sectionName || "").trim();
  const t = normalizeText(text);
  if (!t) return [];

  let chunks = [];

  switch (section) {
    case "listings":     chunks = chunkListings(t);     break;
    case "paymentPlans": chunks = chunkPaymentPlans(t); break;
    case "faqs":         chunks = chunkFaqs(t);         break;
    case "menu":         chunks = chunkMenu(t);         break;
    case "products":     chunks = chunkProducts(t);     break;
    case "booking":      chunks = chunkBooking(t);      break;
    case "team":         chunks = chunkTeam(t);         break;
    case "courses":      chunks = chunkCourses(t);      break;
    case "rooms":        chunks = chunkRooms(t);        break;
    case "delivery":     chunks = chunkDelivery(t);     break;
    case "policies":     chunks = chunkPolicies(t);     break;
    case "profile":
    case "contact":
    case "hours":
    case "offers":
    case "other":
    case "mixed":
    default:
      chunks = chunkSimpleInfo(t);
      break;
  }

  return withSectionTitle(section, chunks);
}