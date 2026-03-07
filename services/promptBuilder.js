function estimateTokens(str = "") {
  return Math.ceil(String(str).length / 4);
}

function hardTrimToTokenBudget(text, budgetTokens) {
  if (!text) return "";
  const maxChars = Math.max(0, budgetTokens * 4);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…[trimmed]";
}

export function buildDataBlockBudgeted(groupedChunks, sectionsOrder, opts = {}) {
  const {
    maxDataTokens = 2500,
    perChunkMaxTokens = 300,
    includeEmptySections = false,
  } = opts;

  let usedTokens = 0;
  const outSections = [];
  let includedChunkCount = 0;

  for (const section of sectionsOrder || []) {
    const items = groupedChunks?.[section] || [];

    if (!items.length) {
      if (includeEmptySections) {
        const header = `${String(section).toUpperCase()}\n\n`;
        const body = `No relevant data found.\n`;
        const cost = estimateTokens(header + body);

        if (usedTokens + cost <= maxDataTokens) {
          outSections.push(header + body);
          usedTokens += cost;
        }
      }
      continue;
    }

    const header = `${String(section).toUpperCase()}\n\n`;
    const headerCost = estimateTokens(header);

    if (usedTokens + headerCost >= maxDataTokens) break;

    let sectionText = "";

    for (const item of items) {
      let chunkText = String(item?.text || "").trim();
      if (!chunkText) continue;

      if (estimateTokens(chunkText) > perChunkMaxTokens) {
        chunkText = hardTrimToTokenBudget(chunkText, perChunkMaxTokens);
      }

      const addition = (sectionText ? "\n" : "") + chunkText;
      const projectedCost =
        usedTokens + headerCost + estimateTokens(sectionText) + estimateTokens(addition);

      if (projectedCost > maxDataTokens) {
        const remaining =
          maxDataTokens - (usedTokens + headerCost + estimateTokens(sectionText));

        if (remaining <= 30) break;

        const trimmed = hardTrimToTokenBudget(chunkText, remaining);
        const trimmedAddition = (sectionText ? "\n" : "") + trimmed;
        const finalProjectedCost =
          usedTokens + headerCost + estimateTokens(sectionText) + estimateTokens(trimmedAddition);

        if (finalProjectedCost <= maxDataTokens) {
          sectionText += trimmedAddition;
          includedChunkCount += 1;
        }

        break;
      }

      sectionText += addition;
      includedChunkCount += 1;
    }

    if (sectionText.trim()) {
      const block = header + sectionText;
      outSections.push(block);
      usedTokens += estimateTokens(block);
    }
  }

  return {
    dataBlock: outSections.join("\n\n"),
    usedTokens,
    includedChunkCount,
  };
}

export function buildChatMessages({
  rulesPrompt,
  groupedChunks,
  userText,
  sectionsOrder,
  maxTotalTokens = 3500,
  maxDataTokens = 2500,
  perChunkMaxTokens = 300,
} = {}) {
  const safeRulesPrompt = String(rulesPrompt || "").trim();
  const safeUserText = String(userText || "").trim();

  const {
    dataBlock,
    usedTokens: dataTokens,
    includedChunkCount,
  } = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
    maxDataTokens,
    perChunkMaxTokens,
  });

  const userContent =
    (dataBlock ? `${dataBlock}\n\n` : "") +
    `User message:\n${safeUserText}`;

  const totalTokens =
    estimateTokens(safeRulesPrompt) + estimateTokens(userContent);

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
      "Outgoing prompt too large. Reduce retrieved chunks, reduce per-chunk size, or reduce memory window.";

    const reducedDataBudget = Math.max(600, Math.floor(maxDataTokens * 0.5));
    const reducedPerChunkMax = Math.max(120, Math.floor(perChunkMaxTokens * 0.7));

    const rebuilt = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
      maxDataTokens: reducedDataBudget,
      perChunkMaxTokens: reducedPerChunkMax,
    });

    const rebuiltUserContent =
      (rebuilt.dataBlock ? `${rebuilt.dataBlock}\n\n` : "") +
      `User message:\n${safeUserText}`;

    const rebuiltTotalTokens =
      estimateTokens(safeRulesPrompt) + estimateTokens(rebuiltUserContent);

    meta.dataTokens = rebuilt.usedTokens;
    meta.includedChunkCount = rebuilt.includedChunkCount;
    meta.totalTokens = rebuiltTotalTokens;

    let finalUserContent = rebuiltUserContent;

    if (rebuiltTotalTokens > maxTotalTokens) {
      const allowedForUser = Math.max(
        200,
        maxTotalTokens -
          estimateTokens(safeRulesPrompt) -
          estimateTokens(rebuilt.dataBlock || "")
      );

      finalUserContent =
        (rebuilt.dataBlock ? `${rebuilt.dataBlock}\n\n` : "") +
        `User message:\n${hardTrimToTokenBudget(safeUserText, allowedForUser)}`;

      meta.totalTokens =
        estimateTokens(safeRulesPrompt) + estimateTokens(finalUserContent);
    }

    return {
      messages: [
        { role: "system", content: safeRulesPrompt },
        { role: "user", content: finalUserContent },
      ],
      meta,
    };
  }

  return {
    messages: [
      { role: "system", content: safeRulesPrompt },
      { role: "user", content: userContent },
    ],
    meta,
  };
}