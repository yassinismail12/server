import Client from "../Client.js";
import { sendWhatsAppTemplate } from "../services/Whatsapp.js";

export async function notifyClientStaffNewOrder({ clientId, payload }) {
  const client = await Client.findById(clientId).lean();
  if (!client) throw new Error("Client not found");

  const staffNumbers = (client.staffNumbers || []).map(n => String(n).trim()).filter(Boolean);
  if (!staffNumbers.length) return { ok: true, sent: 0, reason: "no staff numbers" };

  // Build safe strings (WhatsApp templates are strict)
  const clientName = client.name || "Client";
  const customerName = payload.customerName || "Unknown";
  const customerPhone = payload.customerPhone || "N/A";
  const items = payload.itemsText || "N/A";
  const notes = payload.notes || "—";
  const orderId = payload.orderId || "—";

  let sent = 0;
  const results = [];

  for (const to of staffNumbers) {
    try {
      const r = await sendWhatsAppTemplate({
        to,
        templateName: "new_order_alert",
        languageCode: "en_US",
        bodyParams: [clientName, customerName, customerPhone, items, notes, orderId],
      });
      sent++;
      results.push({ to, ok: true, r });
    } catch (e) {
      results.push({ to, ok: false, error: e.message });
    }
  }

  return { ok: true, sent, results };
}
