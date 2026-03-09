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

function safeSectionLabel(section, sectionTitleMap = null) {
  const raw = String(section || "").trim();
  if (!raw) return "SECTION";

  if (sectionTitleMap && sectionTitleMap[raw]) {
    return String(sectionTitleMap[raw]).trim();
  }

  return raw.replace(/[_-]+/g, " ").toUpperCase();
}

export function buildChatMessages({
  rulesPrompt,
  businessKnowledgeBlock = "",
  groupedChunks,
  userText,
  sectionsOrder,
  maxTotalTokens = 3500,
  maxDataTokens = 2500,
  perChunkMaxTokens = 300,
  sectionTitleMap = null,
} = {}) {
  const safeRulesPrompt = String(rulesPrompt || "").trim();
  const safeBusinessKnowledgeBlock = String(businessKnowledgeBlock || "").trim();
  const safeUserText = String(userText || "").trim();

  const {
    dataBlock,
    usedTokens: dataTokens,
    includedChunkCount,
  } = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
    maxDataTokens,
    perChunkMaxTokens,
    sectionTitleMap,
  });

  const initialUserParts = [
    safeBusinessKnowledgeBlock,
    dataBlock,
    `User message:\n${safeUserText}`,
  ].filter(Boolean);

  let finalUserContent = initialUserParts.join("\n\n");
  let totalTokens =
    estimateTokens(safeRulesPrompt) + estimateTokens(finalUserContent);

  const meta = {
    totalTokens,
    dataTokens,
    includedChunkCount,
    code: null,
    advice: null,
  };

  if (totalTokens > maxTotalTokens) {
    meta.code = "PROMPT_RISK_LONG_MESSAGE";
    meta.advice =
      "Outgoing prompt too large. Reduce extra data, reduce per-chunk size, or reduce message history.";

    const reducedDataBudget = Math.max(500, Math.floor(maxDataTokens * 0.5));
    const reducedPerChunkMax = Math.max(120, Math.floor(perChunkMaxTokens * 0.7));

    const rebuilt = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
      maxDataTokens: reducedDataBudget,
      perChunkMaxTokens: reducedPerChunkMax,
      sectionTitleMap,
    });

    const rebuiltParts = [
      safeBusinessKnowledgeBlock,
      rebuilt.dataBlock,
      `User message:\n${safeUserText}`,
    ].filter(Boolean);

    finalUserContent = rebuiltParts.join("\n\n");
    totalTokens =
      estimateTokens(safeRulesPrompt) + estimateTokens(finalUserContent);

    meta.dataTokens = rebuilt.usedTokens;
    meta.includedChunkCount = rebuilt.includedChunkCount;
    meta.totalTokens = totalTokens;

    if (totalTokens > maxTotalTokens) {
      const fixedParts = [safeBusinessKnowledgeBlock, rebuilt.dataBlock].filter(Boolean);
      const fixedCost =
        estimateTokens(safeRulesPrompt) +
        estimateTokens(fixedParts.join("\n\n")) +
        estimateTokens("User message:\n");

      const remainingForUser = Math.max(120, maxTotalTokens - fixedCost);
      const trimmedUserText = hardTrimToTokenBudget(safeUserText, remainingForUser);

      finalUserContent = [
        ...fixedParts,
        `User message:\n${trimmedUserText}`,
      ].filter(Boolean).join("\n\n");

      meta.totalTokens =
        estimateTokens(safeRulesPrompt) + estimateTokens(finalUserContent);
    }
  }

  return {
    messages: [
      { role: "system", content: safeRulesPrompt },
      { role: "user", content: finalUserContent },
    ],
    meta,
  };
}