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

export function buildDataBlockBudgeted(groupedChunks, sectionsOrder, opts = {}) {
  const {
    maxDataTokens = 2500,
    perChunkMaxTokens = 300,
    includeEmptySections = false,
    sectionTitleMap = null,
  } = opts;

  let usedTokens = 0;
  let includedChunkCount = 0;
  const outSections = [];

  for (const section of sectionsOrder || []) {
    const items = Array.isArray(groupedChunks?.[section]) ? groupedChunks[section] : [];
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

    const sectionParts = [];
    let sectionUsedAny = false;

    for (const item of items) {
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
    ? `EXTRA BUSINESS DATA\n\n${outSections.join("\n\n")}`
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
  maxTotalTokens = 3500,
  maxDataTokens = 2500,
  maxHistoryTokens = 800,
  perChunkMaxTokens = 300,
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

    const reducedDataBudget = Math.max(500, Math.floor(maxDataTokens * 0.5));
    const reducedHistoryBudget = Math.max(200, Math.floor(maxHistoryTokens * 0.5));
    const reducedPerChunkMax = Math.max(120, Math.floor(perChunkMaxTokens * 0.7));

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