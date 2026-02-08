import fetch from "node-fetch";

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";
const TOKEN = process.env.WHATSAPP_TOKEN;

export async function sendWhatsAppText({ phoneNumberId, to, text }) {
  if (!phoneNumberId) throw new Error("Missing phoneNumberId");
  if (!TOKEN) throw new Error("Missing WHATSAPP_TOKEN");

  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeDigits(to),
      type: "text",
      text: { body: String(text || "") },
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`WhatsApp send failed: ${JSON.stringify(data)}`);
  return data;
}
