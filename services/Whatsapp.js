import fetch from "node-fetch";

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

function assertWhatsAppEnv() {
  if (!PHONE_NUMBER_ID) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID");
  if (!TOKEN) throw new Error("Missing WHATSAPP_TOKEN");
}

function normalizeToDigitsE164(to) {
  // Accept "+2010..." or "2010..." and return digits-only (recommended for WA Cloud API)
  const s = String(to || "").trim();
  const digits = s.replace(/[^\d]/g, "");
  return digits;
}

export async function sendWhatsAppTemplate({ to, templateName, languageCode = "en_US", bodyParams = [] }) {
  assertWhatsAppEnv();

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeToDigitsE164(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: "body",
            parameters: bodyParams.map((t) => ({ type: "text", text: String(t ?? "") })),
          },
        ],
      },
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    // Keep the exact Meta error for debugging
    throw new Error(`WhatsApp send failed: ${JSON.stringify(data)}`);
  }

  return data;
}
