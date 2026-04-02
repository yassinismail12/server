// utils/notifyClientStaffLead.js
import { MongoClient } from "mongodb";
import { sendWhatsAppTemplate } from "../services/whatsappTemplate.js";

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";
let mongoConnected = false;

async function connectDB() {
  if (!mongoConnected) {
    await mongoClient.connect();
    mongoConnected = true;
  }
  return mongoClient.db(dbName);
}

function normalizeDigits(value) {
  return String(value || "").replace(/[^\d]/g, "").trim();
}

function uniqueValidNumbers(arr = []) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const n = normalizeDigits(item);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export async function notifyClientStaffLead({ clientId, customerName, customerPhone }) {
  const db = await connectDB();
  const cid = String(clientId || "").trim();
  if (!cid) throw new Error("Missing clientId");

  const client = await db.collection("Clients").findOne({ clientId: cid });
  if (!client) throw new Error("Client not found");

  const staffNumbers = uniqueValidNumbers(client.staffNumbers || []);
  if (!staffNumbers.length) {
    return { ok: false, reason: "no_staff_numbers", sentCount: 0, total: 0, results: [] };
  }

  const phoneNumberId = String(
    process.env.WHATSAPP_PHONE_NUMBER_ID || client.whatsappPhoneNumberId || ""
  ).trim();

  const accessToken = String(
    process.env.WHATSAPP_TOKEN || client.whatsappAccessToken || ""
  ).trim();

  if (!phoneNumberId) {
    return { ok: false, reason: "missing_phone_number_id", sentCount: 0, total: staffNumbers.length, results: [] };
  }

  if (!accessToken) {
    return { ok: false, reason: "missing_access_token", sentCount: 0, total: staffNumbers.length, results: [] };
  }

  const templateName = String(
    client.promptConfig?.leadFlow?.templateName || process.env.WHATSAPP_LEAD_TEMPLATE || ""
  ).trim();

  const languageCode = String(
    client.promptConfig?.leadFlow?.templateLang || process.env.WHATSAPP_LEAD_TEMPLATE_LANG || "ar"
  ).trim();

  if (!templateName) {
    return { ok: false, reason: "missing_template_name", sentCount: 0, total: staffNumbers.length, results: [] };
  }

  const results = [];

  for (const to of staffNumbers) {
    try {
      const result = await sendWhatsAppTemplate({
        phoneNumberId,
        accessToken,
        to,
        templateName,
        languageCode,
        bodyParams: [
          String(customerName || "Unknown").slice(0, 60),  // {{1}} — customer name
          String(customerPhone || "Unknown").slice(0, 60), // {{2}} — customer phone
        ],
      });
      results.push({ to, ok: true, result });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }

  const sentCount = results.filter((r) => r.ok).length;
  return {
    ok: sentCount > 0,
    sentCount,
    total: staffNumbers.length,
    results,
  };
}