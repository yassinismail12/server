function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

function splitByBlankBlocks(text) {
  return normalizeText(text)
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

function sizeChunk(text, size = 1200, overlap = 150) {
  const t = normalizeText(text);
  if (!t) return [];
  if (t.length <= size) return [t];

  const chunks = [];
  const step = Math.max(1, size - overlap);

  for (let i = 0; i < t.length; i += step) {
    const piece = t.slice(i, i + size).trim();
    if (piece) chunks.push(piece);
  }

  return chunks;
}

// Priority:
// 1) --- delimiter
// 2) blank blocks
// 3) markdown headings
// 4) bullets / numbered items
// 5) size fallback
function genericChunk(text) {
  const t = normalizeText(text);
  if (!t) return [];

  let parts = t
    .split(/\n-{3,}\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  parts = splitByBlankBlocks(t);
  if (parts.length > 1) return parts;

  parts = splitByMarkdownHeadings(t);
  if (parts.length > 1) return parts;

  parts = splitByBullets(t);
  if (parts.length > 1) return parts;

  return sizeChunk(t, 1200, 150);
}

function chunkFaqs(text) {
  const t = normalizeText(text);
  if (!t) return [];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 8);

  const headingSplit = splitByMarkdownHeadings(t);
  if (headingSplit.length > 1) return bundle(headingSplit, 8);

  return genericChunk(t);
}

function chunkListings(text) {
  const t = normalizeText(text);
  if (!t) return [];

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

  let chunks = t
    .split(
      /(?=\n?(?:category\s*:|section\s*:|breakfast|lunch|dinner|drinks|desserts|appetizers|main courses))/i
    )
    .map((s) => s.trim())
    .filter(Boolean);

  if (chunks.length > 1) return chunks;

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 12);

  const blankBlocks = splitByBlankBlocks(t);
  if (blankBlocks.length > 1) return bundle(blankBlocks, 6);

  return genericChunk(t);
}

function chunkProducts(text) {
  const t = normalizeText(text);
  if (!t) return [];

  let chunks = splitByCommonRecordStarts(t, [
    "product\\s*\\d*\\s*:",
    "item\\s*\\d*\\s*:",
    "sku\\s*:",
    "category\\s*:",
    "collection\\s*:",
    "brand\\s*:",
  ]);
  if (chunks.length > 1) return chunks;

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 6);

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 12);

  return genericChunk(t);
}

function chunkPaymentPlans(text) {
  const t = normalizeText(text);
  if (!t) return [];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 3);

  const headingSplit = splitByMarkdownHeadings(t);
  if (headingSplit.length > 1) return bundle(headingSplit, 3);

  return genericChunk(t);
}

function chunkBooking(text) {
  const t = normalizeText(text);
  if (!t) return [];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 10);

  return genericChunk(t);
}

function chunkTeam(text) {
  const t = normalizeText(text);
  if (!t) return [];

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
  if (blocks.length > 1) return bundle(blocks, 5);

  return genericChunk(t);
}

function chunkCourses(text) {
  const t = normalizeText(text);
  if (!t) return [];

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

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  const bulletSplit = splitByBullets(t);
  if (bulletSplit.length > 1) return bundle(bulletSplit, 10);

  return genericChunk(t);
}

function chunkPolicies(text) {
  const t = normalizeText(text);
  if (!t) return [];

  const blocks = splitByBlankBlocks(t);
  if (blocks.length > 1) return bundle(blocks, 4);

  const headingSplit = splitByMarkdownHeadings(t);
  if (headingSplit.length > 1) return bundle(headingSplit, 4);

  return genericChunk(t);
}

function chunkSimpleInfo(text) {
  return genericChunk(text);
}

export function chunkSection(sectionName, text) {
  const section = String(sectionName || "").trim();
  const t = normalizeText(text);
  if (!t) return [];

  let chunks = [];

  switch (section) {
    case "listings":
      chunks = chunkListings(t);
      break;
    case "paymentPlans":
      chunks = chunkPaymentPlans(t);
      break;
    case "faqs":
      chunks = chunkFaqs(t);
      break;
    case "menu":
      chunks = chunkMenu(t);
      break;
    case "products":
      chunks = chunkProducts(t);
      break;
    case "booking":
      chunks = chunkBooking(t);
      break;
    case "team":
      chunks = chunkTeam(t);
      break;
    case "courses":
      chunks = chunkCourses(t);
      break;
    case "rooms":
      chunks = chunkRooms(t);
      break;
    case "delivery":
      chunks = chunkDelivery(t);
      break;
    case "policies":
      chunks = chunkPolicies(t);
      break;
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