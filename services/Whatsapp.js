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

export async function sendWhatsAppTemplate({
  phoneNumberId,
  accessToken,
  to,
  templateName,
  languageCode = "en_US",
  bodyParams = [],
}) {
  if (!phoneNumberId) throw new Error("Missing phoneNumberId");
  if (!accessToken) throw new Error("Missing accessToken");

  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
            parameters: bodyParams.map((t) => ({
              type: "text",
              text: String(t ?? ""),
            })),
          },
        ],
      },
    }),
  });

  const raw = await res.text();
  const data = JSON.parse(raw);

  if (!res.ok) {
    throw new Error(`WhatsApp template send failed: ${raw}`);
  }

  return data;
}
