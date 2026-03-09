// utils/notifyClientStaffHumanNeeded.js
import { MongoClient } from "mongodb";
import { sendWhatsAppText } from "../services/whatsappText.js";

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

  const client = await db.collection("Clients").findOne({ clientId });
  if (!client) throw new Error("Client not found");

  const staffNumbers = uniqueValidNumbers(client.staffNumbers || []);
  if (!staffNumbers.length) {
    return { ok: false, reason: "no_staff_numbers" };
  }

  const phoneNumberId =
    String(client.whatsappPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();

  const accessToken =
    String(client.whatsappAccessToken || process.env.WHATSAPP_TOKEN || "").trim();

  if (!phoneNumberId) {
    return { ok: false, reason: "missing_phone_number_id" };
  }

  if (!accessToken) {
    return { ok: false, reason: "missing_access_token" };
  }

  const dashboardBase = String(process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
 const openLink = dashboardBase || "";
  const text = [
    "Bot help needed.",
    `User ID: ${userId}`,
    openLink ? `Open: ${openLink}` : null,
    `source: ${source}`
  ]
    .filter(Boolean)
    .join("\n");

  const results = [];

  for (const to of staffNumbers) {
    try {
      const result = await sendWhatsAppText({
        phoneNumberId,
        accessToken,
        to,
        text,
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