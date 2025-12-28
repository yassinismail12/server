export function buildStaffAlert({ pageId, userId, userMessage }) {
  return `
🚨 HUMAN ESCALATION 🚨

Page ID: ${pageId}
User PSID: ${userId}

Last message:
"${userMessage}"

Reply directly to the customer.
`;
}
