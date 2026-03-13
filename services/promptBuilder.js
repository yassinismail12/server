function estimateTokens(str = "") {
  return Math.ceil(String(str || "").length / 4);
}

function hardTrimToTokenBudget(text, budgetTokens) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const maxChars = Math.max(0, Math.floor(budgetTokens * 4));
  if (raw.length <= maxChars) return raw;
  if (maxChars <= 12) return raw.slice(0, maxChars);

  return raw.slice(0, maxChars).trimEnd() + "\n…[trimmed]";
}

function normalizeChunkText(text = "") {
  return String(text || "").replace(/\n{3,}/g, "\n\n").trim();
}

function safeSectionLabel(section, sectionTitleMap = null) {
  const raw = String(section || "").trim();
  if (!raw) return "SECTION";

  if (sectionTitleMap && sectionTitleMap[raw]) {
    return String(sectionTitleMap[raw]).trim();
  }

  return raw.replace(/[_-]+/g, " ").toUpperCase();
}

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .map((m) => ({
      role: m.role,
      content: String(m.content).trim(),
      createdAt: m.createdAt ? new Date(m.createdAt) : null,
    }));
}

function trimHistoryToBudget(history = [], maxHistoryTokens = 800) {
  const normalized = normalizeHistory(history);
  const picked = [];
  let used = 0;

  for (let i = normalized.length - 1; i >= 0; i--) {
    const msg = normalized[i];
    const cost = estimateTokens(msg.content);

    if (used + cost <= maxHistoryTokens) {
      picked.unshift({ role: msg.role, content: msg.content });
      used += cost;
      continue;
    }

    const remaining = maxHistoryTokens - used;
    if (remaining > 40) {
      const trimmed = hardTrimToTokenBudget(msg.content, remaining);
      if (trimmed) {
        picked.unshift({ role: msg.role, content: trimmed });
        used += estimateTokens(trimmed);
      }
    }
    break;
  }

  return {
    historyMessages: picked,
    usedTokens: used,
  };
}

function normalizeRetrievedChunksShape(groupedChunks, sectionsOrder = []) {
  if (!groupedChunks) return {};

  // New retrieval shape: { retrievedChunks: [...] }
  if (Array.isArray(groupedChunks?.retrievedChunks)) {
    const grouped = {};

    for (const chunk of groupedChunks.retrievedChunks) {
      const section = String(chunk?.section || "other").trim() || "other";
      grouped[section] ||= [];
      grouped[section].push({
        text: normalizeChunkText(chunk?.text || ""),
        score: chunk?.score ?? 0,
      });
    }

    return grouped;
  }

  // Old shape: { menu: [...], offers: [...], ... }
  if (typeof groupedChunks === "object") {
    const grouped = {};

    for (const [section, items] of Object.entries(groupedChunks)) {
      if (!Array.isArray(items)) continue;
      grouped[section] = items
        .map((item) => ({
          text: normalizeChunkText(item?.text || item || ""),
          score: item?.score ?? 0,
        }))
        .filter((item) => item.text);
    }

    return grouped;
  }

  return {};
}

export function buildDataBlockBudgeted(groupedChunks, sectionsOrder, opts = {}) {
  const {
    maxDataTokens = 1800,
    perChunkMaxTokens = 220,
    includeEmptySections = false,
    sectionTitleMap = null,
  } = opts;

  const normalizedGrouped = normalizeRetrievedChunksShape(groupedChunks, sectionsOrder);

  const availableSections = Object.keys(normalizedGrouped);
  const orderedSections = Array.from(
    new Set([...(sectionsOrder || []), ...availableSections])
  );

  let usedTokens = 0;
  let includedChunkCount = 0;
  const outSections = [];

  for (const section of orderedSections) {
    const items = Array.isArray(normalizedGrouped?.[section]) ? normalizedGrouped[section] : [];
    const sectionLabel = safeSectionLabel(section, sectionTitleMap);
    const header = `${sectionLabel}\n`;
    const headerCost = estimateTokens(header);

    if (!items.length) {
      if (!includeEmptySections) continue;

      const emptyBlock = `${header}No relevant data found.`;
      const cost = estimateTokens(emptyBlock);

      if (usedTokens + cost <= maxDataTokens) {
        outSections.push(emptyBlock);
        usedTokens += cost;
      }
      continue;
    }

    if (usedTokens + headerCost >= maxDataTokens) break;

    const sortedItems = [...items].sort((a, b) => (b.score || 0) - (a.score || 0));

    const sectionParts = [];
    let sectionUsedAny = false;

    for (const item of sortedItems) {
      let chunkText = normalizeChunkText(item?.text || "");
      if (!chunkText) continue;

      if (estimateTokens(chunkText) > perChunkMaxTokens) {
        chunkText = hardTrimToTokenBudget(chunkText, perChunkMaxTokens);
      }

      const candidateText = sectionParts.length
        ? `${sectionParts.join("\n\n")}\n\n${chunkText}`
        : chunkText;

      const candidateBlock = `${header}${candidateText}`;
      const candidateCost = estimateTokens(candidateBlock);
      const projectedTotal = usedTokens + candidateCost;

      if (projectedTotal <= maxDataTokens) {
        sectionParts.push(chunkText);
        includedChunkCount += 1;
        sectionUsedAny = true;
        continue;
      }

      const currentSectionText = sectionParts.join("\n\n");
      const currentSectionCost = estimateTokens(`${header}${currentSectionText}`);
      const remainingTokens = maxDataTokens - usedTokens - currentSectionCost;

      if (remainingTokens <= 30) break;

      const trimmedChunk = hardTrimToTokenBudget(chunkText, remainingTokens);
      if (!trimmedChunk) break;

      const trimmedCandidateText = currentSectionText
        ? `${currentSectionText}\n\n${trimmedChunk}`
        : trimmedChunk;

      const trimmedCandidateBlock = `${header}${trimmedCandidateText}`;
      const trimmedProjectedTotal = usedTokens + estimateTokens(trimmedCandidateBlock);

      if (trimmedProjectedTotal <= maxDataTokens) {
        sectionParts.push(trimmedChunk);
        includedChunkCount += 1;
        sectionUsedAny = true;
      }

      break;
    }

    if (sectionUsedAny) {
      const finalBlock = `${header}${sectionParts.join("\n\n")}`.trim();
      outSections.push(finalBlock);
      usedTokens += estimateTokens(finalBlock);
    }
  }

  const dataBlock = outSections.length
    ? `BUSINESS KNOWLEDGE\n\n${outSections.join("\n\n")}`
    : "";

  return {
    dataBlock,
    usedTokens,
    includedChunkCount,
  };
}

export function buildChatMessages({
  rulesPrompt,
  businessKnowledgeBlock = "",
  groupedChunks,
  history = [],
  userText,
  sectionsOrder,
  maxTotalTokens = 3200,
  maxDataTokens = 1800,
  maxHistoryTokens = 700,
  perChunkMaxTokens = 220,
  sectionTitleMap = null,
} = {}) {
  const safeRulesPrompt = String(rulesPrompt || "").trim();
  const safeBusinessKnowledgeBlock = String(businessKnowledgeBlock || "").trim();
  const safeUserText = String(userText || "").trim();

  let {
    dataBlock,
    usedTokens: dataTokens,
    includedChunkCount,
  } = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
    maxDataTokens,
    perChunkMaxTokens,
    sectionTitleMap,
  });

  let { historyMessages, usedTokens: historyTokens } = trimHistoryToBudget(
    history,
    maxHistoryTokens
  );

  let knowledgeBlock = [safeBusinessKnowledgeBlock, dataBlock].filter(Boolean).join("\n\n");

  let messages = [
    { role: "system", content: safeRulesPrompt },
    ...(knowledgeBlock ? [{ role: "system", content: knowledgeBlock }] : []),
    ...historyMessages,
    { role: "user", content: safeUserText },
  ];

  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  const meta = {
    totalTokens,
    dataTokens,
    historyTokens,
    includedChunkCount,
    historyCount: historyMessages.length,
    code: null,
    advice: null,
  };

  if (totalTokens > maxTotalTokens) {
    meta.code = "PROMPT_RISK_LONG_MESSAGE";
    meta.advice =
      "Outgoing prompt too large. Reduce extra data, reduce history, reduce per-chunk size, or trim the current user message.";

    const reducedDataBudget = Math.max(500, Math.floor(maxDataTokens * 0.55));
    const reducedHistoryBudget = Math.max(180, Math.floor(maxHistoryTokens * 0.55));
    const reducedPerChunkMax = Math.max(120, Math.floor(perChunkMaxTokens * 0.75));

    const rebuiltData = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
      maxDataTokens: reducedDataBudget,
      perChunkMaxTokens: reducedPerChunkMax,
      sectionTitleMap,
    });

    dataBlock = rebuiltData.dataBlock;
    dataTokens = rebuiltData.usedTokens;
    includedChunkCount = rebuiltData.includedChunkCount;

    const rebuiltHistory = trimHistoryToBudget(history, reducedHistoryBudget);
    historyMessages = rebuiltHistory.historyMessages;
    historyTokens = rebuiltHistory.usedTokens;

    knowledgeBlock = [safeBusinessKnowledgeBlock, dataBlock].filter(Boolean).join("\n\n");

    messages = [
      { role: "system", content: safeRulesPrompt },
      ...(knowledgeBlock ? [{ role: "system", content: knowledgeBlock }] : []),
      ...historyMessages,
      { role: "user", content: safeUserText },
    ];

    totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    meta.totalTokens = totalTokens;
    meta.dataTokens = dataTokens;
    meta.historyTokens = historyTokens;
    meta.includedChunkCount = includedChunkCount;
    meta.historyCount = historyMessages.length;

    if (totalTokens > maxTotalTokens) {
      const fixedCost =
        estimateTokens(safeRulesPrompt) +
        estimateTokens(knowledgeBlock) +
        historyMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

      const remainingForUser = Math.max(120, maxTotalTokens - fixedCost);
      const trimmedUserText = hardTrimToTokenBudget(safeUserText, remainingForUser);

      messages = [
        { role: "system", content: safeRulesPrompt },
        ...(knowledgeBlock ? [{ role: "system", content: knowledgeBlock }] : []),
        ...historyMessages,
        { role: "user", content: trimmedUserText },
      ];

      meta.totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    }
  }

  return {
    messages,
    meta,
  };
}