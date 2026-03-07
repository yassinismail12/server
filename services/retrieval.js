import KnowledgeChunk from "../KnowledgeChunk.js";

const SECTION_CAPS = {
  profile: 2,
  contact: 2,
  hours: 1,
  offers: 6,
  faqs: 6,
  listings: 8,
  paymentPlans: 4,
  policies: 4,
  menu: 15,
  other: 4,
};

const CORE_SECTIONS = ["profile", "contact", "hours"];

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value = "") {
  return normalizeText(value)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildNGrams(tokens = [], min = 2, max = 3) {
  const out = [];
  for (let n = min; n <= max; n += 1) {
    for (let i = 0; i <= tokens.length - n; i += 1) {
      out.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return out;
}

function uniqueById(items = []) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const id = String(item?._id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }

  return out;
}

function overlapStats(queryText = "", chunkText = "") {
  const qTokens = tokenize(queryText);
  const cTokens = tokenize(chunkText);

  const qSet = new Set(qTokens);
  const cSet = new Set(cTokens);

  let tokenHits = 0;
  for (const token of qSet) {
    if (cSet.has(token)) tokenHits += 1;
  }

  const qNgrams = buildNGrams(qTokens, 2, 3);
  let ngramHits = 0;
  for (const phrase of qNgrams) {
    if (chunkText.includes(phrase)) ngramHits += 1;
  }

  const exactContains = queryText && chunkText.includes(queryText) ? 1 : 0;

  return {
    qTokenCount: qSet.size,
    tokenHits,
    ngramHits,
    exactContains,
  };
}

function scoreChunk(chunk, userText) {
  const query = normalizeText(userText);
  const text = normalizeText(chunk?.text || "");
  const section = String(chunk?.section || "other");
  const mongoTextScore = Number(chunk?.score || 0);

  const stats = overlapStats(query, text);

  let score = 0;

  // Mongo text index score
  score += mongoTextScore * 10;

  // Exact full-query containment
  score += stats.exactContains * 50;

  // Token overlap ratio
  if (stats.qTokenCount > 0) {
    const ratio = stats.tokenHits / stats.qTokenCount;
    score += ratio * 40;
  }

  // Phrase overlap matters a lot
  score += stats.ngramHits * 12;

  // Mild quality boosts for structurally important sections
  if (section === "profile") score += 3;
  if (section === "contact") score += 3;
  if (section === "hours") score += 2;

  // Prefer richer chunks slightly
  const textLength = text.length;
  if (textLength >= 80 && textLength <= 1200) score += 4;

  return score;
}

async function fetchCoreSections({ clientId, botType, wantedSections = CORE_SECTIONS }) {
  const docs = await Promise.all(
    wantedSections.map(async (section) => {
      const doc = await KnowledgeChunk.findOne({ clientId, botType, section })
        .sort({ createdAt: -1 })
        .lean();
      return doc || null;
    })
  );

  return docs.filter(Boolean);
}

async function fetchRecentChunks({ clientId, botType, limit = 30 }) {
  return KnowledgeChunk.find({ clientId, botType })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

function chooseDynamicCoreSections(scored = []) {
  const strong = scored
    .filter((item) => (item?._smartScore || 0) > 15)
    .map((item) => item.section)
    .filter(Boolean);

  const dynamic = new Set([...CORE_SECTIONS, ...strong]);
  return Array.from(dynamic);
}

function groupAndCap(results, caps = SECTION_CAPS) {
  const grouped = {};

  for (const item of results) {
    const section = item?.section || "other";
    grouped[section] ||= [];

    const cap = caps[section] ?? 6;
    if (grouped[section].length < cap) {
      grouped[section].push(item);
    }
  }

  return grouped;
}

export async function retrieveChunks({ clientId, botType = "default", userText }) {
  const safeText = String(userText || "").trim();

  // No question text: return core chunks + a few recent chunks
  if (!safeText) {
    const [coreChunks, recentChunks] = await Promise.all([
      fetchCoreSections({ clientId, botType, wantedSections: CORE_SECTIONS }),
      fetchRecentChunks({ clientId, botType, limit: 20 }),
    ]);

    const merged = uniqueById([...coreChunks, ...recentChunks]);
    return groupAndCap(merged);
  }

  // 1) Try Mongo text search first
  let textResults = [];
  try {
    textResults = await KnowledgeChunk.find(
      { clientId, botType, $text: { $search: safeText } },
      {
        score: { $meta: "textScore" },
        section: 1,
        text: 1,
        createdAt: 1,
      }
    )
      .limit(50)
      .lean();
  } catch {
    textResults = [];
  }

  // 2) Also fetch recent chunks so we can score broadly if text search misses something important
  const recentChunks = await fetchRecentChunks({ clientId, botType, limit: 40 });

  // 3) Merge and score everything by actual semantic-ish overlap, not hardcoded keywords
  let merged = uniqueById([...textResults, ...recentChunks]).map((chunk) => ({
    ...chunk,
    _smartScore: scoreChunk(chunk, safeText),
  }));

  merged.sort((a, b) => {
    if ((b._smartScore || 0) !== (a._smartScore || 0)) {
      return (b._smartScore || 0) - (a._smartScore || 0);
    }
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  // 4) Always bring core sections from chunks, but let strong results expand what matters
  const dynamicCoreSections = chooseDynamicCoreSections(merged.slice(0, 12));
  const coreChunks = await fetchCoreSections({
    clientId,
    botType,
    wantedSections: dynamicCoreSections,
  });

  // 5) Re-merge after injecting core sections, then sort again
  merged = uniqueById([...coreChunks, ...merged]).map((chunk) => ({
    ...chunk,
    _smartScore: scoreChunk(chunk, safeText),
  }));

  merged.sort((a, b) => {
    if ((b._smartScore || 0) !== (a._smartScore || 0)) {
      return (b._smartScore || 0) - (a._smartScore || 0);
    }
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  // 6) Keep best chunk pool, then cap per section
  const finalPool = merged.slice(0, 30);

  return groupAndCap(finalPool);
}