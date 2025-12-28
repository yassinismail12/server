import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function notifyStaffWhatsApp({ to, message, pageId, psid }) {
  if (!to) {
    console.warn("⚠️ No staff WhatsApp number configured");
    return;
  }

  // Create a direct Messenger link to the conversation
  const convoLink = `https://m.me/${pageId}?ref=${psid}`;

  // ✅ Log the numbers before sending
  console.log("📲 Sending WhatsApp message");
  console.log("From:", process.env.TWILIO_WHATSAPP_FROM);
  console.log("To:", `whatsapp:${to}`);

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM, // whatsapp:+14155238886
    to: `whatsapp:${to}`,
    body: `${message}\n\n💬 Open conversation: ${convoLink}`
  });

  console.log("📲 Staff notified via WhatsApp with direct link");
}
