// utils/notifyClientStaffHumanNeeded.js
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

export async function notifyClientStaffHumanNeeded({ clientId, pageId, userId, source }) {
  const db = await connectDB();

  const cid = String(clientId || "").trim();
  if (!cid) {
    throw new Error("Missing clientId");
  }

  const client = await db.collection("Clients").findOne({ clientId: cid });
  if (!client) {
    throw new Error("Client not found");
  }

  const staffNumbers = uniqueValidNumbers(client.staffNumbers || []);
  if (!staffNumbers.length) {
    return { ok: false, reason: "no_staff_numbers", sentCount: 0, total: 0, results: [] };
  }

  // Global sender first, optional per-client override still supported
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

  const dashboardBase = String(process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
  const openLink = dashboardBase || "-";

  const clientName = String(client.name || client.businessName || "Client").trim();
  const templateName = String(process.env.WHATSAPP_HUMAN_TEMPLATE || "human_needed").trim();
  const languageCode = String(process.env.WHATSAPP_HUMAN_TEMPLATE_LANG || "en_US").trim();

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
          clientName,          // {{1}}
          String(userId || "-"), // {{2}}
          String(source || "-"), // {{3}}
          openLink,            // {{4}}
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