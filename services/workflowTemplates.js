function buildHumanEscalationBlock(promptConfig = {}) {
  const enabled = promptConfig?.humanEscalation?.enabled !== false;
  const token = promptConfig?.humanEscalation?.token || "[Human_request]";

  if (!enabled) return "";

  return `
HUMAN ESCALATION RULES
- If the user asks to speak to a staff member, cashier, manager, agent, or real person:
  output exactly:
  ${token}
- Do not include any other text.
`.trim();
}

function buildOrderFlowBlock(client = {}) {
  const orderFlow = client?.promptConfig?.orderFlow;
  const businessName =
    client?.promptConfig?.businessName || client?.name || "This business";

  if (!orderFlow?.enabled) return "";

  const requiredFields = orderFlow.requiredFields || [];

  return `
ORDER FLOW RULES (CRITICAL)
- When the user wants to place an order, follow the order flow exactly.
- Ask for missing details ONE question at a time.
- Never ask multiple questions in one message.
- Do not show the order summary until ALL required details are collected.
- If an item has required options and they are missing, ask for the missing option before confirming.

REQUIRED ORDER FIELDS
${requiredFields.map((f, i) => `${i + 1}) ${f}`).join("\n")}

CONFIRMATION STEP
After all required details are collected, show the summary using exactly these labels:

${orderFlow.summaryTitle || "Order Summary"}
${orderFlow.storeLabel || "Store"}: ${businessName}
${orderFlow.nameLabel || "Customer Name"}: <name>
${orderFlow.phoneLabel || "Customer Phone"}: <phone>
${orderFlow.itemsLabel || "Items"}: <items + quantities + options>
${orderFlow.deliveryLabel || "Delivery Info"}: <pickup OR delivery + address>
${orderFlow.notesLabel || "Notes"}: <notes or "None">

Then ask exactly:
${orderFlow.confirmationQuestion || "Confirm order?"}

IMPORTANT CONFIRMATION RULES
- If the user confirms:
  1) Output the FULL summary again
  2) Then output exactly this confirmation message:
${orderFlow.confirmationMessage || "Your order request has been received."}
  3) Then output this token on a new line:
${orderFlow.token || "[ORDER_REQUEST]"}
  4) Do not ask any more questions

- If the user cancels or refuses confirmation:
  Reply exactly:
  Okay, I cancelled the order request.
- Do not output the order token if cancelled.
`.trim();
}

export function buildWorkflowBlocks(client = {}) {
  const promptConfig = client?.promptConfig || {};

  const blocks = [
    buildHumanEscalationBlock(promptConfig),
    buildOrderFlowBlock(client),
  ].filter(Boolean);

  return blocks.join("\n\n");
}