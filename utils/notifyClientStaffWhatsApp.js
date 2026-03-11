import { connectToDB as connectDB } from "../services/db.js";
import { sendWhatsAppTemplate } from "../services/whatsappTemplate.js";

function normalizeId(id) {
  return String(id || "").trim();
}

function waSafeParam(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{5,}/g, "    ")
    .trim()
    .slice(0, 1024);
}

export async function notifyClientStaffNewOrderByClientId({ clientId, payload }) {
  const db = await connectDB();
  const cid = normalizeId(clientId);

  if (!cid) {
    throw new Error("Missing clientId");
  }

  const client = await db.collection("Clients").findOne({ clientId: cid });
  if (!client) {
    throw new Error(`Client not found for clientId=${cid}`);
  }

  let staffNumbers = [];
  if (Array.isArray(client.staffNumbers) && client.staffNumbers.length > 0) {
    staffNumbers = client.staffNumbers;
  } else if (client.staffWhatsApp) {
    staffNumbers = [client.staffWhatsApp];
  }

  staffNumbers = staffNumbers
    .map((n) => String(n || "").trim())
    .filter(Boolean);

  console.log("📲 WhatsApp staff numbers resolved:", staffNumbers);

  if (!staffNumbers.length) {
    console.warn("⚠️ No staff WhatsApp numbers found for client:", cid);
    return { ok: true, sent: 0, reason: "no_staff_numbers", results: [] };
  }


  const clientName = waSafeParam(client.name || client.businessName || "Client");
  const customerName = waSafeParam(payload?.customerName || "Unknown");
  const customerPhone = waSafeParam(payload?.customerPhone || "N/A");
  const items = waSafeParam(payload?.itemsText || "N/A");
  const notes = waSafeParam(payload?.notes || "—");
  const orderId = waSafeParam(payload?.orderId || "—");

  let sent = 0;
  const results = [];

  for (const toRaw of staffNumbers) {
    const to = waSafeParam(toRaw);

    try {
      console.log("📤 Sending WhatsApp order alert to:", to);

   const response = await sendWhatsAppTemplate({
  to,
  templateName: "new_order_alert",
  languageCode: "en_US",
  bodyParams: [clientName, customerName, customerPhone, items, notes, orderId],
});

      sent += 1;
      results.push({ to, ok: true, response });
    } catch (e) {
      console.error("❌ WhatsApp send failed for", to, e.message);
      results.push({ to, ok: false, error: e.message });
    }
  }

  return {
    ok: true,
    sent,
    results,
  };
}