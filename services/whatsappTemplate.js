// services/whatsappTemplate.js
import fetch from "node-fetch";

const API_VERSION = (process.env.WHATSAPP_API_VERSION || "v22.0").trim();

function normalizeToDigitsE164(to) {
  return String(to || "")
    .trim()
    .replace(/[^\d]/g, "");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Send a WhatsApp template message.
 *
 * Priority:
 *  1) phoneNumberId passed in
 *  2) process.env.WHATSAPP_PHONE_NUMBER_ID
 *
 * Priority:
 *  1) accessToken passed in
 *  2) process.env.WHATSAPP_TOKEN
 */
export async function sendWhatsAppTemplate({
  phoneNumberId,
  to,
  templateName,
  languageCode = "en_US",
  bodyParams = [],
  accessToken,
}) {
  const pnid = String(phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  if (!pnid) {
    throw new Error("Missing phoneNumberId (or WHATSAPP_PHONE_NUMBER_ID)");
  }

  const token = String(accessToken || process.env.WHATSAPP_TOKEN || "").trim();
  if (!token) {
    throw new Error("Missing accessToken (or WHATSAPP_TOKEN)");
  }

  const toDigits = normalizeToDigitsE164(to);
  if (!toDigits) {
    throw new Error("Missing recipient number");
  }

  const name = String(templateName || "").trim();
  if (!name) {
    throw new Error("Missing templateName");
  }

  const lang = String(languageCode || "en_US").trim();

  const url = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(pnid)}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toDigits,
    type: "template",
    template: {
      name,
      language: { code: lang },
      ...(Array.isArray(bodyParams) && bodyParams.length > 0
        ? {
            components: [
              {
                type: "body",
                parameters: bodyParams.map((value) => ({
                  type: "text",
                  text: String(value ?? ""),
                })),
              },
            ],
          }
        : {}),
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await resp.text();
  const data = safeJsonParse(raw);

  if (!resp.ok) {
    throw new Error(
      `WhatsApp template send failed (HTTP ${resp.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}