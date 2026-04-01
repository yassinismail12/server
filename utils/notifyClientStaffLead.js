// utils/notifyClientStaffLead.js
import { sendWhatsAppTemplate } from "../services/Whatsapp.js";
import { connectToDB as connectDB } from "../services/db.js";

function normalizeId(id) {
  return String(id || "").trim();
}

export async function notifyClientStaffLead({ clientId, customerName, customerPhone }) {
  try {
    const db = await connectDB();
    const client = await db.collection("Clients").findOne({
      clientId: normalizeId(clientId),
    });

    if (!client) return { ok: false, error: "Client not found" };

    const staffNumber = client.staffWhatsApp || (client.staffNumbers || [])[0];
    if (!staffNumber) return { ok: false, error: "No staff number configured" };

    const templateName = client.promptConfig?.leadFlow?.templateName;
    const templateLang = client.promptConfig?.leadFlow?.templateLang || "ar";

    if (!templateName) return { ok: false, error: "No lead template configured" };

    const phoneNumberId = client.whatsappPhoneNumberId;
    const accessToken = client.whatsappAccessToken;

    if (!phoneNumberId || !accessToken) {
      return { ok: false, error: "Client WhatsApp not connected" };
    }

    const result = await sendWhatsAppTemplate({
      phoneNumberId,
      accessToken,
      to: staffNumber,
      templateName,
      languageCode: templateLang,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: String(customerName || "Unknown").slice(0, 60) },
            { type: "text", text: String(customerPhone || "Unknown").slice(0, 60) },
          ],
        },
      ],
    });

    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
