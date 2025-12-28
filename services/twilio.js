import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export async function notifyStaffWhatsApp({ to, message }) {
  if (!to) {
    console.warn("⚠️ No staff WhatsApp number configured");
    return;
  }

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM, // whatsapp:+14155238886
    to: `whatsapp:${to}`,
    body: message
  });

  console.log("📲 Staff notified via WhatsApp");
}
