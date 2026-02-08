import fetch from "node-fetch";

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";
const TOKEN = process.env.WHATSAPP_TOKEN;

function assertWhatsAppEnv() {
  if (!TOKEN) throw new Error("Missing WHATSAPP_TOKEN");
}

function normalizeToDigitsE164(to) {
  // Accept "+2010..." or "2010..." and return digits-only (recommended for WA Cloud API)
  const s = String(to || "").trim();
  return s.replace(/[^\d]/g, "");
}

export async function sendWhatsAppText({ phoneNumberId, to, text }) {
  assertWhatsAppEnv();
  if (!phoneNumberId) throw new Error("Missing phoneNumberId");

  const url = `https://graph.facebook.com/${API_VERSION}/${String(phoneNumberId).trim()}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeToDigitsE164(to),
      type: "text",
      text: { body: String(text ?? "") },
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    // Keep the exact Meta error for debugging
    throw new Error(`WhatsApp send failed: ${JSON.stringify(data)}`);
  }

  return data;
}
