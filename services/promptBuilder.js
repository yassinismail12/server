// promptBuilder.js

function estimateTokens(str = "") {
  // Very practical approximation:
  // English ~ 4 chars/token, Arabic can be a bit different but this is fine for budget warnings.
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
    maxDataTokens = 2500,     // how much of the prompt is allowed for KB chunks
    perChunkMaxTokens = 300,  // cap any single chunk so one chunk can't blow budget
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

    // Start section
    const header = `${section.toUpperCase()}\n\n`;
    let sectionText = "";
    let headerCost = estimateTokens(header);

    // If we can't even afford the header, stop completely
    if (usedTokens + headerCost >= maxDataTokens) break;

    // Add chunks under this section until budget
    for (const item of items) {
      if (usedTokens + headerCost >= maxDataTokens) break;

      let chunkText = String(item?.text || "").trim();
      if (!chunkText) continue;

      // Cap per chunk
      const chunkTokens = estimateTokens(chunkText);
      if (chunkTokens > perChunkMaxTokens) {
        chunkText = hardTrimToTokenBudget(chunkText, perChunkMaxTokens);
      }

      const addition = (sectionText ? "\n" : "") + chunkText;
      const additionCost = estimateTokens(addition);

      // If adding the whole chunk exceeds budget, try trimming it to fit
      if (usedTokens + headerCost + estimateTokens(sectionText) + additionCost > maxDataTokens) {
        const remaining = maxDataTokens - (usedTokens + headerCost + estimateTokens(sectionText));
        if (remaining <= 30) {
          // too little space left to add meaningful text
          break;
        }
        const trimmed = hardTrimToTokenBudget(chunkText, remaining);
        const trimmedAddition = (sectionText ? "\n" : "") + trimmed;

        // final check
        if (usedTokens + headerCost + estimateTokens(sectionText) + estimateTokens(trimmedAddition) <= maxDataTokens) {
          sectionText += trimmedAddition;
          includedChunkCount += 1;
        }
        break; // budget exhausted for this section
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

export function buildChatMessages({
  rulesPrompt,
  groupedChunks,
  userText,
  sectionsOrder,
  // budgets
  maxTotalTokens = 3500, // total tokens allowed for EVERYTHING here (system + user + data)
  maxDataTokens = 2500,
  perChunkMaxTokens = 300,
} = {}) {
  const safeRulesPrompt = String(rulesPrompt || "").trim();
  const safeUserText = String(userText || "").trim();

  // 1) Build KB block with its own budget first
  const { dataBlock, usedTokens: dataTokens, includedChunkCount } = buildDataBlockBudgeted(
    groupedChunks,
    sectionsOrder,
    { maxDataTokens, perChunkMaxTokens }
  );

  // 2) Build final user content
  // IMPORTANT: don't add "No relevant data found." everywhere — it wastes budget.
  const userContent =
    (dataBlock ? `${dataBlock}\n\n` : "") +
    `User message:\n${safeUserText}`;

  // 3) Final budget check (system + user)
  const totalTokens = estimateTokens(safeRulesPrompt) + estimateTokens(userContent);

  const meta = {
    totalTokens,
    dataTokens,
    includedChunkCount,
    code: null,
    advice: null,
  };

  // 4) If too big, shrink further: first shrink data budget, then trim user content last
  if (totalTokens > maxTotalTokens) {
    meta.code = "PROMPT_RISK_LONG_MESSAGE";
    meta.advice =
      "Outgoing prompt too large. Reduce retrieved chunks (K), reduce per-chunk size, or reduce conversation window.";

    // Reduce data budget aggressively and rebuild once
    const reducedDataBudget = Math.max(600, Math.floor(maxDataTokens * 0.5));
    const rebuilt = buildDataBlockBudgeted(groupedChunks, sectionsOrder, {
      maxDataTokens: reducedDataBudget,
      perChunkMaxTokens: Math.max(120, Math.floor(perChunkMaxTokens * 0.7)),
    });

    const rebuiltUserContent =
      (rebuilt.dataBlock ? `${rebuilt.dataBlock}\n\n` : "") +
      `User message:\n${safeUserText}`;

    const rebuiltTotalTokens = estimateTokens(safeRulesPrompt) + estimateTokens(rebuiltUserContent);

    meta.dataTokens = rebuilt.usedTokens;
    meta.includedChunkCount = rebuilt.includedChunkCount;
    meta.totalTokens = rebuiltTotalTokens;

    // If STILL too big, trim user text slightly (rare)
    let finalUserContent = rebuiltUserContent;
    if (rebuiltTotalTokens > maxTotalTokens) {
      const allowedForUser = Math.max(200, maxTotalTokens - estimateTokens(safeRulesPrompt) - estimateTokens(rebuilt.dataBlock));
      finalUserContent =
        (rebuilt.dataBlock ? `${rebuilt.dataBlock}\n\n` : "") +
        `User message:\n${hardTrimToTokenBudget(safeUserText, allowedForUser)}`;

      meta.totalTokens = estimateTokens(safeRulesPrompt) + estimateTokens(finalUserContent);
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
