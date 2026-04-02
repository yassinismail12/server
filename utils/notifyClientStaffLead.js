// utils/notifyClientStaffLead.js
import { sendWhatsAppTemplate } from "../services/Whatsapp.js";
import { connectToDB as connectDB } from "../services/db.js";

function normalizeId(id) {
  return String(id || "").trim();
}

export async function notifyClientStaffLead({ clientId, customerName, customerPhone }) {
  try {
    console.log("📞 notifyClientStaffLead called:", { clientId, customerName, customerPhone });
    
    const db = await connectDB();
    const client = await db.collection("Clients").findOne({
      clientId: normalizeId(clientId),
    });

    if (!client) {
      console.error("❌ notifyClientStaffLead: client not found for", clientId);
      return { ok: false, error: "Client not found" };
    }

    const staffNumber = client.staffWhatsApp || (client.staffNumbers || [])[0];
    console.log("📱 staffNumber:", staffNumber);
    
    const templateName = client.promptConfig?.leadFlow?.templateName;
    const templateLang = client.promptConfig?.leadFlow?.templateLang || "ar";
    console.log("📄 templateName:", templateName, "lang:", templateLang);

    if (!staffNumber) return { ok: false, error: "No staff number configured" };
    if (!templateName) return { ok: false, error: "No lead template configured" };

    const phoneNumberId = client.whatsappPhoneNumberId;
    const accessToken = client.whatsappAccessToken;
    console.log("🔌 phoneNumberId:", phoneNumberId, "hasToken:", Boolean(accessToken));

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

    console.log("✅ sendWhatsAppTemplate result:", JSON.stringify(result));
    return { ok: true, result };
  } catch (e) {
    console.error("❌ notifyClientStaffLead exception:", e.message);
    return { ok: false, error: e.message };
  }
}