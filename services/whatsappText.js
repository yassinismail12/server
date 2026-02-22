// services/whatsappText.js
import fetch from "node-fetch";

const API_VERSION = (process.env.WHATSAPP_API_VERSION || "v22.0").trim();

/**
 * WhatsApp Cloud API expects `to` as digits-only (no +).
 */
function normalizeToDigitsE164(to) {
  const s = String(to || "").trim();
  return s.replace(/[^\d]/g, "");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Send a WhatsApp text message.
 *
 * Priority:
 *  1) accessToken passed in (per-client from Mongo)
 *  2) process.env.WHATSAPP_TOKEN (fallback / legacy / testing)
 */
export async function sendWhatsAppText({ phoneNumberId, to, text, accessToken }) {
  const pnid = String(phoneNumberId || "").trim();
  if (!pnid) throw new Error("Missing phoneNumberId");

  const token = String(accessToken || process.env.WHATSAPP_TOKEN || "").trim();
  if (!token) throw new Error("Missing WhatsApp access token (accessToken or WHATSAPP_TOKEN)");

  const url = `https://graph.facebook.com/${API_VERSION}/${pnid}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: normalizeToDigitsE164(to),
    type: "text",
    text: { body: String(text ?? "") },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  const data = safeJsonParse(raw);

  if (!res.ok) {
    // keep Meta error JSON for debugging
    throw new Error(`WhatsApp send failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}