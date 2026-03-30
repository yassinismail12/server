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

// ─── Build profile link based on platform ────────────────────────────────────
// Messenger: Facebook profile URL (visible to page admins)
// Instagram: IG user IDs don't map to public URLs reliably — pass the user ID
// WhatsApp: no profile link available
function buildProfileLink(source, userId) {
  if (!userId || userId === "-") return "-";
  const uid = String(userId).trim();

  if (source === "messenger") {
    return `https://www.facebook.com/profile.php?id=${uid}`;
  }

  if (source === "instagram") {
    // IG user IDs are numeric — we can link to the IG inbox in Business Suite
    return `https://business.facebook.com/direct/instagram/?recipientId=${uid}`;
  }

  // WhatsApp — phone digits, can build a wa.me link
  if (source === "whatsapp") {
    const digits = uid.replace(/[^\d]/g, "");
    return digits ? `https://wa.me/${digits}` : "-";
  }

  return "-";
}

export async function notifyClientStaffHumanNeeded({ clientId, pageId, userId, source }) {
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

  const dashboardBase = String(process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
  const openLink = dashboardBase || "-";
  const clientName = String(client.name || client.businessName || "Client").trim();
  const templateName = String(process.env.WHATSAPP_HUMAN_TEMPLATE || "human_needed").trim();
  const languageCode = String(process.env.WHATSAPP_HUMAN_TEMPLATE_LANG || "en_US").trim();

  // ✅ Build profile link for the customer
  const profileLink = buildProfileLink(source, userId);

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
          clientName,              // {{1}} — business name
          String(userId || "-"),   // {{2}} — customer user ID
          String(source || "-"),   // {{3}} — platform (messenger/instagram/whatsapp)
          openLink,                // {{4}} — dashboard link
          profileLink,             // {{5}} — direct profile/conversation link
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