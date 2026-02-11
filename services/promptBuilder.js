// services/promptBuilder.js

function estimateTokens(str = "") {
  // Practical approximation:
  // English ~ 4 chars/token. Arabic varies but fine for budgeting.
  return Math.ceil(String(str).length / 4);
}

function hardTrimToTokenBudget(text, budgetTokens) {
  if (!text) return "";
  const maxChars = Math.max(0, budgetTokens * 4);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…[trimmed]";
}

/**
 * Build a data block that fits within a token budget.
 * groupedChunks: { [sectionName]: [{ text: "..." , ... }, ...] }
 * sectionsOrder: ["properties", "policies", ...]
 */
export function buildDataBlockBudgeted(groupedChunks, sectionsOrder, opts = {}) {
  const {
    maxDataTokens = 2500,
    perChunkMaxTokens = 300,
    includeEmptySections = false,
  } = opts;

  let usedTokens = 0;
  const outSections = [];
  let includedChunkCount = 0;

  for (const section of sectionsOrder) {
    const items = groupedChunks?.[section] || [];
    if (!items.length) {
      if (includeEmptySections) {
        const header = `${section.toUpperCase()}\n\n`;
        const body = `No relevant data found.\n`;
        const cost = estimateTokens(header + body);
        if (usedTokens + cost <= maxDataTokens) {
          outSections.push(header + body);
          usedTokens += cost;
        }
      }
      continue;
    }

    const header = `${section.toUpperCase()}\n\n`;
    let sectionText = "";
    const headerCost = estimateTokens(header);

    if (usedTokens + headerCost >= maxDataTokens) break;

    for (const item of items) {
      if (usedTokens + headerCost >= maxDataTokens) break;

      let chunkText = String(item?.text || "").trim();
      if (!chunkText) continue;

      const chunkTokens = estimateTokens(chunkText);
      if (chunkTokens > perChunkMaxTokens) {
        chunkText = hardTrimToTokenBudget(chunkText, perChunkMaxTokens);
      }

      const addition = (sectionText ? "\n" : "") + chunkText;
      const additionCost = estimateTokens(addition);

      if (usedTokens + headerCost + estimateTokens(sectionText) + additionCost > maxDataTokens) {
        const remaining = maxDataTokens - (usedTokens + headerCost + estimateTokens(sectionText));
        if (remaining <= 30) break;

        const trimmed = hardTrimToTokenBudget(chunkText, remaining);
        const trimmedAddition = (sectionText ? "\n" : "") + trimmed;

        if (
          usedTokens + headerCost + estimateTokens(sectionText) + estimateTokens(trimmedAddition) <= maxDataTokens
        ) {
          sectionText += trimmedAddition;
          includedChunkCount += 1;
        }
        break;
      }

      sectionText += addition;
      includedChunkCount += 1;
    }

    if (sectionText.trim()) {
      outSections.push(header + sectionText);
      usedTokens += estimateTokens(header + sectionText);
    }
  }

  return {
    dataBlock: outSections.join("\n\n"),
    usedTokens,
    includedChunkCount,
  };
}

/**
 * Budget and format conversation history.
 * history items: [{ role: "user"|"assistant", content: "..." }, ...]
 */
export function buildHistoryBudgeted(history = [], maxHistoryTokens = 600) {
  const clean = Array.isArray(history)
    ? history
        .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
        .map((h) => ({ role: h.role, content: h.content.trim() }))
        .filter((h) => h.content)
    : [];

  // Prefer most recent history
  let used = 0;
  const picked = [];

  for (let i = clean.length - 1; i >= 0; i--) {
    const h = clean[i];
    const cost = estimateTokens(h.content) + 4;
    if (used + cost > maxHistoryTokens) break;
    picked.unshift(h);
    used += cost;
  }

  return { historyMessages: picked, usedTokens: used, count: picked.length };
}

export function buildChatMessages({
  rulesPrompt,
  groupedChunks,
  userText,
  sectionsOrder,

  // optional conversation history
  history = [],
  maxHistoryTokens = 600,

  // budgets
  maxTotalTokens = 3500,
  maxDataTokens = 2500,
  perChunkMaxTokens = 300,
} = {}) {
  const safeRulesPrompt = String(rulesPrompt || "").trim();
  const safeUserText = String(userText || "").trim();

  // 0) history (budgeted)
  const { historyMessages, usedTokens: historyTokens, count: historyCount } = buildHistoryBudgeted(
    history,
    maxHistoryTokens
  );

  // 1) KB block
  const { dataBlock, usedTokens: dataTokens, includedChunkCount } = buildDataBlockBudgeted(
    groupedChunks,
    sectionsOrder,
    { maxDataTokens, perChunkMaxTokens }
  );

  // 2) user content
  const userContent = (dataBlock ? `${dataBlock}\n\n` : "") + `User message:\n${safeUserText}`;

  // 3) total budget check (system + history + user)
  const totalTokens =
    estimateTokens(safeRulesPrompt) +
    historyTokens +
    estimateTokens(userContent);

  const meta = {
    totalTokens,
    dataTokens,
    historyTokens,
    historyCount,
    includedChunkCount,
    code: null,
    advice: null,
  };

  // 4) If too big, shrink: reduce history first, then data, then user
  if (totalTokens > maxTotalTokens) {
    meta.code = "PROMPT_RISK_LONG_MESSAGE";
    meta.advice =
      "Outgoing prompt too large. Reduce history window, reduce retrieved chunks (K), reduce per-chunk size, or reduce user length.";

    // A) reduce history budget
    const reducedHistoryBudget = Math.max(120, Math.floor(maxHistoryTokens * 0.5));
    const rebuiltHistory = buildHistoryBudgeted(history, reducedHistoryBudget);

    // B) reduce data budget
    const reducedDataBudget = Math.max(600, Math.floor(maxDataTokens * 0.5));
    const rebuiltData = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
      maxDataTokens: reducedDataBudget,
      perChunkMaxTokens: Math.max(120, Math.floor(perChunkMaxTokens * 0.7)),
    });

    const rebuiltUserContent =
      (rebuiltData.dataBlock ? `${rebuiltData.dataBlock}\n\n` : "") +
      `User message:\n${safeUserText}`;

    const rebuiltTotalTokens =
      estimateTokens(safeRulesPrompt) +
      rebuiltHistory.usedTokens +
      estimateTokens(rebuiltUserContent);

    meta.dataTokens = rebuiltData.usedTokens;
    meta.includedChunkCount = rebuiltData.includedChunkCount;
    meta.historyTokens = rebuiltHistory.usedTokens;
    meta.historyCount = rebuiltHistory.count;
    meta.totalTokens = rebuiltTotalTokens;

    let finalUserContent = rebuiltUserContent;

    // C) still too big → trim user text last
    if (rebuiltTotalTokens > maxTotalTokens) {
      const allowedForUser = Math.max(
        200,
        maxTotalTokens -
          estimateTokens(safeRulesPrompt) -
          rebuiltHistory.usedTokens -
          estimateTokens(rebuiltData.dataBlock || "")
      );

      finalUserContent =
        (rebuiltData.dataBlock ? `${rebuiltData.dataBlock}\n\n` : "") +
        `User message:\n${hardTrimToTokenBudget(safeUserText, allowedForUser)}`;

      meta.totalTokens =
        estimateTokens(safeRulesPrompt) +
        rebuiltHistory.usedTokens +
        estimateTokens(finalUserContent);
    }

    return {
      messages: [
        { role: "system", content: safeRulesPrompt },
        ...rebuiltHistory.historyMessages,
        { role: "user", content: finalUserContent },
      ],
      meta,
    };
  }

  return {
    messages: [
      { role: "system", content: safeRulesPrompt },
      ...historyMessages,
      { role: "user", content: userContent },
    ],
    meta,
  };
}
