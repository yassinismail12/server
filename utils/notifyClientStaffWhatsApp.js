import mongoose from "mongoose";
import Client from "../Client.js";
import { sendWhatsAppTemplate } from "../services/Whatsapp.js";

/**
 * WhatsApp template params cannot contain:
 * - newlines (\n, \r)
 * - tabs (\t)
 * - more than 4 consecutive spaces
 */
function waSafeParam(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")   // remove newlines/tabs
    .replace(/\s{5,}/g, "    ")  // max 4 consecutive spaces
    .trim();
}

function isObjectIdLike(value) {
  const v = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(v);
}

/**
 * Notify client staff about a new order via WhatsApp Cloud API
 *
 * Accepts:
 * - clientId = Mongo _id (ObjectId string)  ✅
 * - clientId = business clientId like "realestate" ✅
 */
export async function notifyClientStaffNewOrder({ clientId, payload }) {
  const clientIdStr = String(clientId || "").trim();
  if (!clientIdStr) throw new Error("clientId is required");

  // 1) Load client (supports _id OR business clientId)
  const query = isObjectIdLike(clientIdStr)
    ? { _id: clientIdStr }
    : { clientId: clientIdStr };

  const client = await Client.findOne(query).lean();
  if (!client) {
    throw new Error(`Client not found for ${JSON.stringify(query)}`);
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
    .map((n) => String(n).trim())
    .filter(Boolean);

  console.log("📲 WhatsApp staff numbers resolved:", staffNumbers);

  if (!staffNumbers.length) {
    console.warn("⚠️ No staff WhatsApp numbers found for client:", clientIdStr);
    return { ok: true, sent: 0, reason: "no staff numbers" };
  }

  // 3) Prepare SAFE template values (sanitize EVERYTHING)
  const clientName = waSafeParam(client.name || "Client");
  const customerName = waSafeParam(payload?.customerName || "Unknown");
  const customerPhone = waSafeParam(payload?.customerPhone || "N/A");

  // IMPORTANT: items/notes are most likely to contain newlines (AI summary)
  const items = waSafeParam(payload?.itemsText || "N/A");
  const notes = waSafeParam(payload?.notes || "—");

  const orderId = waSafeParam(payload?.orderId || "—");

  // 4) Send WhatsApp messages
  let sent = 0;
  const results = [];

  for (const toRaw of staffNumbers) {
    const to = waSafeParam(toRaw);

    try {
      console.log("📤 Sending WhatsApp order alert to:", to);

      const r = await sendWhatsAppTemplate({
        to,
        templateName: "new_order_alert",
        languageCode: "en_US",
        bodyParams: [clientName, customerName, customerPhone, items, notes, orderId],
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
