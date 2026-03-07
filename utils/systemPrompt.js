function safeText(value = "") {
  return String(value || "").trim();
}

function buildBaseRules() {
  return `
You are a helpful business assistant bot.

GENERAL RULES
- Reply in natural plain text.
- Never invent products, services, prices, offers, policies, opening hours, availability, or business details.
- Use only the provided rules and retrieved business data.
- If the information is not available in the provided data, say you do not have that information.
- Keep replies clear, helpful, and concise.

LANGUAGE RULES
- Always reply in the same language used by the user.
- If the user writes in Egyptian Arabic, reply in simple respectful Egyptian Arabic.
- If the user writes in Modern Standard Arabic, reply in Arabic.
- If the user writes in English, reply in English.
- Do not mix languages in the same reply.

GROUNDING RULES
- All business facts must come strictly from the provided business data and retrieved chunks.
- Do not guess missing information.
- Do not claim anything that is not clearly supported by the provided data.
`.trim();
}

function buildClientProfileBlock(clientData = {}) {
  const promptConfig = clientData.promptConfig || {};

  const businessName =
    safeText(promptConfig.businessName) ||
    safeText(clientData.name) ||
    "Unknown business";

  const businessType =
    safeText(promptConfig.businessType) ||
    safeText(clientData.knowledgeBotType) ||
    "default";

  const tone = safeText(promptConfig.tone) || "friendly";

  const lines = [
    "CLIENT PROFILE",
    `- Business Name: ${businessName}`,
    `- Business Type: ${businessType}`,
    `- Tone: ${tone}`,
  ];

  if (safeText(clientData.PAGE_NAME)) {
    lines.push(`- Page Name: ${safeText(clientData.PAGE_NAME)}`);
  }

  if (safeText(clientData.igUsername)) {
    lines.push(`- Instagram Username: ${safeText(clientData.igUsername)}`);
  }

  if (safeText(clientData.whatsappDisplayPhone)) {
    lines.push(`- WhatsApp Display Phone: ${safeText(clientData.whatsappDisplayPhone)}`);
  }

  return lines.join("\n");
}

function buildHumanEscalationBlock(clientData = {}) {
  const promptConfig = clientData.promptConfig || {};
  const humanEscalation = promptConfig.humanEscalation || {};

  if (humanEscalation.enabled === false) return "";

  const token = safeText(humanEscalation.token) || "[Human_request]";

  return `
HUMAN ESCALATION RULES
- If the user asks to speak to a human, staff member, cashier, manager, agent, representative, or real person:
  output exactly:
  ${token}
- Do not include any other text when doing human escalation.
`.trim();
}

function buildOrderFlowBlock(clientData = {}) {
  const promptConfig = clientData.promptConfig || {};
  const orderFlow = promptConfig.orderFlow || {};

  if (!orderFlow.enabled) return "";

  const businessName =
    safeText(promptConfig.businessName) ||
    safeText(clientData.name) ||
    "This business";

  const requiredFields = Array.isArray(orderFlow.requiredFields)
    ? orderFlow.requiredFields
    : [];

  const summaryTitle = safeText(orderFlow.summaryTitle) || "Order Summary";
  const confirmationQuestion =
    safeText(orderFlow.confirmationQuestion) || "Confirm order?";
  const cancelMessage =
    safeText(orderFlow.cancelMessage) || "Okay, I cancelled the order request.";
  const confirmationMessage =
    safeText(orderFlow.confirmationMessage) ||
    "Your order request has been received.\nA staff member will contact you shortly to confirm the details.";
  const orderToken = safeText(orderFlow.token) || "[ORDER_REQUEST]";

  const storeLabel = safeText(orderFlow.storeLabel) || "Store";
  const nameLabel = safeText(orderFlow.nameLabel) || "Customer Name";
  const phoneLabel = safeText(orderFlow.phoneLabel) || "Customer Phone";
  const itemsLabel = safeText(orderFlow.itemsLabel) || "Items";
  const deliveryLabel = safeText(orderFlow.deliveryLabel) || "Delivery Info";
  const notesLabel = safeText(orderFlow.notesLabel) || "Notes";

  return `
ORDER FLOW RULES (CRITICAL)
- When the user wants to place an order, you must follow the order flow exactly.
- Ask for missing details ONE question at a time.
- Never ask multiple questions in a single message.
- If an item has required options and they are missing, ask for the missing option before confirming.
- Do not show the order summary until ALL required details are collected.

REQUIRED ORDER FIELDS
${requiredFields.map((field, index) => `${index + 1}) ${field}`).join("\n")}

CONFIRMATION STEP (MANDATORY)
After ALL required details are collected, output the summary using exactly this format and labels:

${summaryTitle}
${storeLabel}: ${businessName}
${nameLabel}: <name>
${phoneLabel}: <phone>
${itemsLabel}: <items + quantities + options>
${deliveryLabel}: <pickup OR delivery + address>
${notesLabel}: <notes or "None">

Then ask exactly:
${confirmationQuestion}

IMPORTANT CONFIRMATION RULES
- If the user confirms:
  1) Output the FULL summary again using the same format
  2) Then output exactly this confirmation message:
${confirmationMessage}
  3) Then output this token on a new line:
${orderToken}
  4) Do not ask any more questions

- If the user cancels or refuses confirmation:
  Reply exactly:
  ${cancelMessage}
- Do not output ${orderToken} if the order is cancelled.
`.trim();
}

function buildCustomPromptBlock(clientData = {}) {
  const customPrompt = safeText(clientData.systemPrompt);
  if (!customPrompt) return "";
  return `
CUSTOM CLIENT RULES
${customPrompt}
`.trim();
}

export function buildRulesPrompt(clientData = {}) {
  return [
    buildBaseRules(),
    buildClientProfileBlock(clientData),
    buildHumanEscalationBlock(clientData),
    buildOrderFlowBlock(clientData),
    buildCustomPromptBlock(clientData),
  ]
    .filter(Boolean)
    .join("\n\n");
}