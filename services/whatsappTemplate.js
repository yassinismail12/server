// services/whatsappTemplate.js
import fetch from "node-fetch";

const API_VERSION = (process.env.WHATSAPP_API_VERSION || "v20.0").trim();

function normalizeToDigits(to) {
  return String(to || "").trim().replace(/[^\d]/g, "");
}

async function safeJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function sendWhatsAppTemplate({
  phoneNumberId,
  to,
  templateName,
  languageCode = "en_US",
  bodyParams = [], // array of strings for {{1}}, {{2}}, ...
  accessToken,
}) {
  const pnid = String(phoneNumberId || "").trim();
  if (!pnid) throw new Error("Missing phoneNumberId");

  const toDigits = normalizeToDigits(to);
  if (!toDigits) throw new Error("Missing to");

  if (!templateName) throw new Error("Missing templateName");
  if (!accessToken) throw new Error("Missing accessToken");

  const url = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(pnid)}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toDigits,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length
        ? {
            components: [
              {
                type: "body",
                parameters: bodyParams.map((t) => ({ type: "text", text: String(t) })),
              },
            ],
          }
        : {}),
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await safeJson(resp);
  if (!resp.ok) {
    const err = new Error(`WhatsApp template send failed (${resp.status})`);
    err.data = data;
    throw err;
  }
  return data;
}