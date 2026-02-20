// services/whatsappText.js
import fetch from "node-fetch";

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";

/**
 * WhatsApp Cloud API expects `to` as digits-only (no +)
 */
function normalizeToDigitsE164(to) {
  const s = String(to || "").trim();
  return s.replace(/[^\d]/g, "");
}

/**
 * Send a WhatsApp text message.
 * - Prefer per-client token (accessToken) from DB (Embedded Signup).
 * - Fallback to env WHATSAPP_TOKEN for legacy/testing.
 */
export async function sendWhatsAppText({ phoneNumberId, to, text, accessToken }) {
  if (!phoneNumberId) throw new Error("Missing phoneNumberId");

  const token = (accessToken || process.env.WHATSAPP_TOKEN || "").trim();
  if (!token) throw new Error("Missing WhatsApp access token (accessToken or WHATSAPP_TOKEN)");

  const url = `https://graph.facebook.com/${API_VERSION}/${String(phoneNumberId).trim()}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeToDigitsE164(to),
      type: "text",
      text: { body: String(text ?? "") },
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`WhatsApp send failed: ${JSON.stringify(data)}`);
  }

  return data;
}