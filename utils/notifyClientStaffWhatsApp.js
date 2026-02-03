import Client from "../Client.js";
import { sendWhatsAppTemplate } from "../services/Whatsapp.js";

/**
 * Notify client staff about a new order via WhatsApp Cloud API
 */
export async function notifyClientStaffNewOrder({ clientId, payload }) {
  // 1) Load client
  const client = await Client.findById(clientId).lean();
  if (!client) {
    throw new Error(`Client not found for id=${clientId}`);
  }

  // 2) Resolve staff numbers (SUPPORT OLD + NEW SCHEMA)
  let staffNumbers = [];

  if (Array.isArray(client.staffNumbers) && client.staffNumbers.length > 0) {
    staffNumbers = client.staffNumbers;
  } else if (client.staffWhatsApp) {
    // backward compatibility (single number)
    staffNumbers = [client.staffWhatsApp];
  }

  staffNumbers = staffNumbers
    .map(n => String(n).trim())
    .filter(Boolean);

  console.log("📲 WhatsApp staff numbers resolved:", staffNumbers);

  if (!staffNumbers.length) {
    console.warn("⚠️ No staff WhatsApp numbers found for client:", clientId);
    return { ok: true, sent: 0, reason: "no staff numbers" };
  }

  // 3) Prepare safe template values
  const clientName = client.name || "Client";
  const customerName = payload.customerName || "Unknown";
  const customerPhone = payload.customerPhone || "N/A";
  const items = payload.itemsText || "N/A";
  const notes = payload.notes || "—";
  const orderId = payload.orderId || "—";

  // 4) Send WhatsApp messages
  let sent = 0;
  const results = [];

  for (const to of staffNumbers) {
    try {
      console.log("📤 Sending WhatsApp order alert to:", to);

      const r = await sendWhatsAppTemplate({
        to,
        templateName: "new_order_alert",
        languageCode: "en",
        bodyParams: [
          clientName,
          customerName,
          customerPhone,
          items,
          notes,
          orderId,
        ],
      });

      sent++;
      results.push({ to, ok: true, response: r });
    } catch (e) {
      console.error("❌ WhatsApp send failed for", to, e.message);
      results.push({ to, ok: false, error: e.message });
    }
  }

  return { ok: true, sent, results };
}
