// worker.js
// Runs inside your existing server.js process — no separate Render service needed.
// Call startWorker() once after mongoose connects in server.js.
//
// Handles: messenger, instagram, whatsapp jobs from the shared BullMQ queue.

import { createWorker } from "./queue.js";
import { connectToDB as connectDB } from "./services/db.js";
import { retrieveChunks } from "./services/retrieval.js";
import { buildChatMessages } from "./services/promptBuilder.js";
import { getChatCompletion } from "./services/openai.js";
import { buildRulesPrompt } from "./utils/systemPrompt.js";
import { sendMessengerReply, sendMarkAsRead } from "./services/messenger.js";
import { sendWhatsAppText } from "./services/whatsappText.js";
import { notifyClientStaffHumanNeeded } from "./utils/notifyClientStaffHumanNeeded.js";
import { notifyClientStaffNewOrderByClientId } from "./utils/notifyClientStaffWhatsApp.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import Order from "./order.js";
import mongoose from "mongoose";
import fetch from "node-fetch";

// ─── Shared utils ─────────────────────────────────────────────────────────────

function normalizeId(id) { return String(id || "").trim(); }

function sanitizeToken(token) {
  return String(token || "")
    .replace(/^Bearer\s+/i, "").replace(/^"|"$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "").trim();
}

function isLikelyValidToken(t) {
  const s = sanitizeToken(t);
  return s.length >= 60 && /^EAA/i.test(s);
}

function isNewDay(lastDate) {
  const today = new Date();
  const d = lastDate ? new Date(lastDate) : null;
  return !d || d.getDate() !== today.getDate() || d.getMonth() !== today.getMonth() || d.getFullYear() !== today.getFullYear();
}

function detectLang(text = "") {
  return /[\u0600-\u06FF]/.test(String(text || "")) ? "ar" : "en";
}

function extractLine(text, label) {
  const m = String(text || "").match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)\\s*$`, "im"));
  return m ? m[1].trim() : "";
}

function waSafe(v) {
  return String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{5,}/g, "    ").trim().slice(0, 1024);
}

function normalizePhone(p) { return String(p || "").trim().replace(/[^\d]/g, ""); }

// History helpers
function trimHistory(history = [], max = 20) {
  return (Array.isArray(history) ? history : []).slice(-max);
}

function injectHistory(baseMessages = [], history = []) {
  const histMsgs = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  if (!histMsgs.length) return baseMessages;

  const sys = baseMessages.filter((m) => m.role === "system");
  const nonSys = baseMessages.filter((m) => m.role !== "system");
  const last = nonSys[nonSys.length - 1];
  return last?.role === "user"
    ? [...sys, ...nonSys.slice(0, -1), ...histMsgs, last]
    : [...sys, ...histMsgs, ...nonSys];
}

// Shared flag parser
function parseFlags(msg) {
  let text = msg;
  const flags = { human: false, order: false, tour: false };
  if (text.includes("[Human_request]")) { flags.human = true; text = text.replace("[Human_request]", "").trim(); }
  if (text.includes("[ORDER_REQUEST]")) { flags.order = true; text = text.replace("[ORDER_REQUEST]", "").trim(); }
  if (text.includes("[TOUR_REQUEST]")) { flags.tour = true; text = text.replace("[TOUR_REQUEST]", "").trim(); }
  return { text, flags };
}

// ─── IG send helper ───────────────────────────────────────────────────────────

async function sendIgDM(pageId, pageToken, recipientId, text) {
  const url = new URL(`https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/messages`);
  url.searchParams.set("access_token", pageToken);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(`IG send failed: ${JSON.stringify(d)}`);
  }
}

// ─── Quota helper (shared across platforms) ───────────────────────────────────

async function checkAndIncrementQuota(db, filter, pageIdOrIgStr) {
  await db.collection("Clients").updateOne(filter, {
    $inc: { messageCount: 1 }, $set: { updatedAt: new Date() },
  });
  const fresh = await db.collection("Clients").findOne(filter);
  if (!fresh) return { allowed: false };

  const limit = fresh.messageLimit ?? 1000;
  const count = fresh.messageCount ?? 0;

  if (count > limit) return { allowed: false, reason: "quota_exceeded" };

  if (count === limit - 100 && !fresh.quotaWarningSent) {
    await sendQuotaWarning(pageIdOrIgStr).catch(() => {});
    await db.collection("Clients").updateOne(filter, { $set: { quotaWarningSent: true } });
  }

  return { allowed: true };
}

// ─── Save helpers ─────────────────────────────────────────────────────────────

async function saveConvoMessenger(db, pageId, userId, history, clientId) {
  await db.collection("Conversations").updateOne(
    { pageId, userId, source: "messenger" },
    {
      $set: { pageId, clientId, history: trimHistory(history), lastInteraction: new Date(), source: "messenger", updatedAt: new Date() },
      $setOnInsert: { humanEscalation: false, humanRequestCount: 0, tourRequestCount: 0, orderRequestCount: 0, createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function saveConvoIG(db, igStr, userId, history, clientId) {
  await db.collection("Conversations").updateOne(
    { igBusinessId: igStr, userId, source: "instagram" },
    {
      $set: { igBusinessId: igStr, clientId, history: trimHistory(history), lastInteraction: new Date(), source: "instagram", updatedAt: new Date() },
      $setOnInsert: { humanEscalation: false, humanRequestCount: 0, tourRequestCount: 0, orderRequestCount: 0, createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function saveConvoWhatsApp(db, clientId, userId, history, extra = {}) {
  await db.collection("Conversations").updateOne(
    { clientId: String(clientId), userId, source: "whatsapp" },
    {
      $set: {
        clientId: String(clientId), userId, source: "whatsapp", sourceLabel: "WhatsApp",
        history: trimHistory(history), lastInteraction: new Date(), updatedAt: new Date(),
        ...extra,
      },
      $setOnInsert: { humanEscalation: false, createdAt: new Date() },
    },
    { upsert: true }
  );
}

// ─── Order flow helper (shared) ───────────────────────────────────────────────

async function handleOrderFlow({ db, clientId, assistantMessage, externalUserId, channel, pageIdOrIgStr }) {
  const customerName = extractLine(assistantMessage, "Customer Name") || "Unknown";
  const customerPhone = extractLine(assistantMessage, "Customer Phone") || "N/A";
  const itemsText = extractLine(assistantMessage, "Items") || assistantMessage;
  const deliveryInfo = extractLine(assistantMessage, "Delivery Info");
  const notes = [deliveryInfo ? `Delivery: ${deliveryInfo}` : null, `Notes: ${extractLine(assistantMessage, "Notes") || "None"}`]
    .filter(Boolean).join(" | ");

  try {
    await notifyClientStaffNewOrderByClientId({
      clientId,
      payload: {
        customerName: waSafe(customerName),
        customerPhone: waSafe(customerPhone),
        itemsText: waSafe(itemsText),
        notes: waSafe(notes),
        orderId: waSafe(`ORD-${Date.now()}`),
        channel,
      },
    });
  } catch (e) {
    console.warn(`⚠️ [worker/${channel}] order notify failed:`, e.message);
  }

  try {
    await Order.create({
      clientId,
      channel,
      customer: { name: customerName, phone: customerPhone === "N/A" ? "" : customerPhone, externalUserId },
      itemsText: assistantMessage,
      notes,
      status: "new",
    });
  } catch (e) {
    console.warn(`⚠️ [worker/${channel}] order save failed:`, e.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MESSENGER PROCESSOR
// ═════════════════════════════════════════════════════════════════════════════

async function processMessengerJob({ pageId, sender_psid, userMessage, eventKey }) {
  const db = await connectDB();
  const pageIdStr = normalizeId(pageId);

  const clientDoc = await db.collection("Clients").findOne({ pageId: pageIdStr });
  if (!clientDoc || clientDoc.active === false) return;

  const clientId = clientDoc.clientId;

  // Human escalation check
  let convoCheck = await db.collection("Conversations").findOne({ pageId: pageIdStr, userId: sender_psid, source: "messenger" });

  if (convoCheck?.humanEscalation === true) {
    if (convoCheck?.botResumeAt && new Date() >= new Date(convoCheck.botResumeAt)) {
      await db.collection("Conversations").updateOne(
        { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
        { $set: { humanEscalation: false, botResumeAt: null, autoResumedAt: new Date() } }
      );
    } else {
      return; // still in human escalation, bot stays silent
    }
  }

  await sendMarkAsRead(sender_psid, pageId);
  await new Promise((r) => setTimeout(r, 400));

  const rulesPrompt = buildRulesPrompt(clientDoc);
  const botType = clientDoc?.knowledgeBotType || "default";
  const sectionsOrder = Array.isArray(clientDoc?.sectionsOrder) && clientDoc.sectionsOrder.length
    ? clientDoc.sectionsOrder : ["menu", "offers", "hours"];

  const convo = await db.collection("Conversations").findOne({ pageId: pageIdStr, userId: sender_psid, source: "messenger" });
  const history = trimHistory(Array.isArray(convo?.history) ? convo.history : []);

  let greeting = "";
  if (!convo || isNewDay(convo.lastInteraction)) {
    greeting = detectLang(userMessage) === "ar" ? "أهلًا، سعيدين بوجودك اليوم 👋" : "Hi, good to see you today 👋";
  }

  // Quota
  const quota = await checkAndIncrementQuota(db, { pageId: pageIdStr }, pageIdStr);
  if (!quota.allowed) {
    if (quota.reason === "quota_exceeded") await sendMessengerReply(sender_psid, "⚠️ Message limit reached.", pageId);
    return;
  }

  // Retrieval + AI
  let grouped = {};
  try { grouped = await retrieveChunks({ clientId, botType, userText: userMessage, retrievalQuery: userMessage, maxChunks: 4}); }
  catch (e) { console.warn("⚠️ [worker/messenger] retrieveChunks failed:", e.message); }

  const { messages: base } = buildChatMessages({ rulesPrompt, groupedChunks: grouped, userText: userMessage, sectionsOrder });
  const messagesForAI = injectHistory(base, history);

  let raw;
  try { raw = await getChatCompletion(messagesForAI); }
  catch (err) {
    console.error("❌ [worker/messenger] AI error:", err.message);
    await sendMessengerReply(sender_psid, "⚠️ I'm having trouble right now. Please try again shortly.", pageId);
    return;
  }

  const { text: assistantMessage, flags } = parseFlags(raw);

  // Human escalation
  if (flags.human) {
    const botResumeAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await db.collection("Conversations").updateOne(
      { pageId: pageIdStr, userId: sender_psid, source: "messenger" },
      { $set: { humanEscalation: true, botResumeAt, humanEscalationStartedAt: new Date(), updatedAt: new Date() }, $inc: { humanRequestCount: 1 } },
      { upsert: true }
    );
    try { await notifyClientStaffHumanNeeded({ clientId, pageId: pageIdStr, userId: sender_psid, source: "messenger" }); }
    catch (e) { console.warn("⚠️ [worker/messenger] human notify failed:", e.message); }

    const msg = "👤 A human agent will take over shortly.\nThe assistant will return when staff reactivate it from the dashboard.\n\nسيقوم أحد موظفي الدعم بالرد عليك قريبًا وسيعود المساعد عند إعادة تفعيله من لوحة التحكم.";
    await sendMessengerReply(sender_psid, msg, pageId);
    history.push({ role: "user", content: userMessage, createdAt: new Date() }, { role: "assistant", content: msg, createdAt: new Date() });
    await saveConvoMessenger(db, pageIdStr, sender_psid, history, clientId);
    return;
  }

  // Order
  if (flags.order) {
    await db.collection("Conversations").updateOne({ pageId: pageIdStr, userId: sender_psid, source: "messenger" }, { $inc: { orderRequestCount: 1 } }, { upsert: true });
    await handleOrderFlow({ db, clientId, assistantMessage, externalUserId: sender_psid, channel: "messenger", pageIdOrIgStr: pageIdStr });
    const msg = "✅ Your order request has been received.\nA staff member will contact you shortly.\n\nتم استلام طلبك وسيتم التواصل معك قريبًا.";
    await sendMessengerReply(sender_psid, msg, pageId);
    history.push({ role: "user", content: userMessage, createdAt: new Date() }, { role: "assistant", content: msg, createdAt: new Date() });
    await saveConvoMessenger(db, pageIdStr, sender_psid, history, clientId);
    return;
  }

  // Normal reply
  const combined = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;
  history.push({ role: "user", content: userMessage, createdAt: new Date() }, { role: "assistant", content: combined, createdAt: new Date() });
  await saveConvoMessenger(db, pageIdStr, sender_psid, history, clientId);
  await sendMessengerReply(sender_psid, combined, pageId);
}

// ═════════════════════════════════════════════════════════════════════════════
// INSTAGRAM PROCESSOR
// ═════════════════════════════════════════════════════════════════════════════

async function processInstagramJob({ igBusinessId, senderId, userText, clientId, pageId, pageToken }) {
  const db = await connectDB();
  const igStr = normalizeId(igBusinessId);

  const clientDoc = await db.collection("Clients").findOne({ $or: [{ igBusinessId: igStr }, { igId: igStr }] });
  if (!clientDoc || clientDoc.active === false) return;

  const resolvedClientId = normalizeId(clientId || clientDoc.clientId);
  const resolvedPageId = normalizeId(pageId || clientDoc.pageId || clientDoc.PAGE_ID);
  const resolvedPageToken = sanitizeToken(pageToken || clientDoc.pageAccessToken || clientDoc.PAGE_ACCESS_TOKEN || "");
  if (!resolvedPageId || !isLikelyValidToken(resolvedPageToken)) return;

  // Human escalation check
  let convoCheck = await db.collection("Conversations").findOne({ igBusinessId: igStr, userId: senderId, source: "instagram" });
  if (convoCheck?.humanEscalation === true) {
    if (convoCheck?.botResumeAt && new Date() >= new Date(convoCheck.botResumeAt)) {
      await db.collection("Conversations").updateOne(
        { igBusinessId: igStr, userId: senderId, source: "instagram" },
        { $set: { humanEscalation: false, botResumeAt: null, autoResumedAt: new Date() } }
      );
    } else return;
  }

  const rulesPrompt = buildRulesPrompt(clientDoc);
  const botType = clientDoc?.knowledgeBotType || "default";
  const sectionsOrder = Array.isArray(clientDoc?.sectionsOrder) && clientDoc.sectionsOrder.length
    ? clientDoc.sectionsOrder : ["menu", "offers", "hours"];

  const convo = await db.collection("Conversations").findOne({ igBusinessId: igStr, userId: senderId, source: "instagram" });
  const history = trimHistory(Array.isArray(convo?.history) ? convo.history : []);

  let greeting = "";
  if (!convo || isNewDay(convo.lastInteraction)) {
    greeting = detectLang(userText) === "ar" ? "أهلًا، سعيدين بوجودك اليوم 👋" : "Hi, good to see you today 👋";
  }

  // Quota
  const filter = { $or: [{ igBusinessId: igStr }, { igId: igStr }] };
  const quota = await checkAndIncrementQuota(db, filter, igStr);
  if (!quota.allowed) {
    if (quota.reason === "quota_exceeded") await sendIgDM(resolvedPageId, resolvedPageToken, senderId, "⚠️ Message limit reached.");
    return;
  }

  // Retrieval + AI
  let grouped = {};
  try { grouped = await retrieveChunks({ clientId: resolvedClientId, botType, userText, retrievalQuery: userText, maxChunks: 4 }); }
  catch (e) { console.warn("⚠️ [worker/instagram] retrieveChunks failed:", e.message); }

  const { messages: base } = buildChatMessages({ rulesPrompt, groupedChunks: grouped, userText, sectionsOrder });
  const messagesForAI = injectHistory(base, history);

  let raw;
  try { raw = await getChatCompletion(messagesForAI); }
  catch (err) {
    console.error("❌ [worker/instagram] AI error:", err.message);
    await sendIgDM(resolvedPageId, resolvedPageToken, senderId, "⚠️ I'm having trouble right now. Please try again shortly.");
    return;
  }

  const { text: assistantMessage, flags } = parseFlags(raw);

  // Human escalation
  if (flags.human) {
    const botResumeAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await db.collection("Conversations").updateOne(
      { igBusinessId: igStr, userId: senderId, source: "instagram" },
      { $set: { humanEscalation: true, botResumeAt, humanEscalationStartedAt: new Date(), updatedAt: new Date() }, $inc: { humanRequestCount: 1 } },
      { upsert: true }
    );
    try { await notifyClientStaffHumanNeeded({ clientId: resolvedClientId, pageId: resolvedPageId, userId: senderId, source: "instagram" }); }
    catch (e) { console.warn("⚠️ [worker/instagram] human notify failed:", e.message); }

    const msg = "👤 A human agent will take over shortly.\nThe assistant will return when staff reactivate it from the dashboard.\n\nسيقوم أحد موظفي الدعم بالرد عليك قريبًا وسيعود المساعد عند إعادة تفعيله من لوحة التحكم.";
    await sendIgDM(resolvedPageId, resolvedPageToken, senderId, msg);
    history.push({ role: "user", content: userText, createdAt: new Date() }, { role: "assistant", content: msg, createdAt: new Date() });
    await saveConvoIG(db, igStr, senderId, history, resolvedClientId);
    return;
  }

  // Order
  if (flags.order) {
    await db.collection("Conversations").updateOne({ igBusinessId: igStr, userId: senderId, source: "instagram" }, { $inc: { orderRequestCount: 1 } }, { upsert: true });
    await handleOrderFlow({ db, clientId: resolvedClientId, assistantMessage, externalUserId: senderId, channel: "instagram", pageIdOrIgStr: igStr });
    const msg = "✅ Your order request has been received.\nA staff member will contact you shortly.\n\nتم استلام طلبك وسيتم التواصل معك قريبًا.";
    await sendIgDM(resolvedPageId, resolvedPageToken, senderId, msg);
    history.push({ role: "user", content: userText, createdAt: new Date() }, { role: "assistant", content: msg, createdAt: new Date() });
    await saveConvoIG(db, igStr, senderId, history, resolvedClientId);
    return;
  }

  // Normal reply
  const combined = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;
  history.push({ role: "user", content: userText, createdAt: new Date() }, { role: "assistant", content: combined, createdAt: new Date() });
  await saveConvoIG(db, igStr, senderId, history, resolvedClientId);
  await sendIgDM(resolvedPageId, resolvedPageToken, senderId, combined);
}

// ═════════════════════════════════════════════════════════════════════════════
// WHATSAPP PROCESSOR
// ═════════════════════════════════════════════════════════════════════════════

function parseSourceChoice(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["1", "sales", "sell", "buy", "rent"].includes(t)) return "sales";
  if (["2", "support", "help"].includes(t)) return "support";
  if (["3", "order", "orders", "شراء", "طلب"].includes(t)) return "order";
  return "";
}

function sourceMenuText() {
  return "Hi 👋\nPlease choose what you need:\n\n1) Sales / Properties\n2) Support\n3) Order\n\nReply with 1, 2, or 3.";
}

function getWaToken(client) {
  const dbToken = String(client?.whatsappAccessToken || "").trim();
  if (dbToken) return dbToken;
  const key = String(client?.whatsappTokenKey || "").trim().toLowerCase();
  if (key && process.env[`WHATSAPP_TOKEN_${key.toUpperCase()}`]) return process.env[`WHATSAPP_TOKEN_${key.toUpperCase()}`];
  return process.env.WHATSAPP_TOKEN || "";
}

async function processWhatsAppJob({ clientId, fromDigits, text, whatsappPhoneNumberId, msgId }) {
  // Use mongoose connection directly (same as whatsapp.js does)
  const db = mongoose.connection.db;

  const client = await db.collection("Clients").findOne({
    clientId: String(clientId),
    active: { $ne: false },
  });
  if (!client) return;

  const whatsappAccessToken = getWaToken(client);
  if (!whatsappAccessToken) return;

  const phoneIdStr = String(whatsappPhoneNumberId);

  // Staff number check
  const staffDigits = [
    ...(Array.isArray(client.staffNumbers) ? client.staffNumbers : []),
    ...(client.staffWhatsApp ? [client.staffWhatsApp] : []),
  ].map(normalizePhone);
  if (staffDigits.includes(fromDigits)) return;

  // Load conversation
  const convo = await db.collection("Conversations").findOne({
    clientId: String(clientId), userId: fromDigits, source: "whatsapp",
  });

  // Human escalation
  if (convo?.humanEscalation === true) return;

  const inboundAt = new Date();
  const history = trimHistory(Array.isArray(convo?.history) ? convo.history : []);
  const clientAwaitSource = Boolean(client.awaitSource);
  const sourceChoiceExisting = convo?.sourceChoice || "";
  const convoMeta = { whatsappPhoneNumberId: phoneIdStr };

  const botType = client?.knowledgeBotType || "default";
  const sectionsOrder = Array.isArray(client?.sectionsOrder) && client.sectionsOrder.length
    ? client.sectionsOrder
    : Array.isArray(client?.sectionsPresent) && client.sectionsPresent.length
    ? client.sectionsPresent
    : ["faqs", "listings", "paymentPlans"];

  // ── Source choice flow ──────────────────────────────────────────────────────
  const needsChoice = clientAwaitSource && !sourceChoiceExisting;
  if (needsChoice) {
    const picked = parseSourceChoice(text);
    const updatedHistory = [...history, { role: "user", content: text, createdAt: inboundAt }];

    if (!picked) {
      const shouldSendMenu = !convo || isNewDay(convo.lastInteraction) || convo?.awaitSource !== true;
      await saveConvoWhatsApp(db, clientId, fromDigits, updatedHistory, {
        lastMessage: text.slice(0, 200), lastMessageAt: inboundAt, lastDirection: "in",
        awaitSource: true, sourceChoice: "", meta: convoMeta,
      });
      if (shouldSendMenu) {
        await sendWhatsAppText({ phoneNumberId: phoneIdStr, to: fromDigits, text: sourceMenuText(), accessToken: whatsappAccessToken });
      }
      return;
    }

    await saveConvoWhatsApp(db, clientId, fromDigits, updatedHistory, {
      lastMessage: text.slice(0, 200), lastMessageAt: inboundAt, lastDirection: "in",
      awaitSource: false, sourceChoice: picked, meta: convoMeta,
    });
    await sendWhatsAppText({
      phoneNumberId: phoneIdStr, to: fromDigits,
      text: `✅ Got it. You selected: ${picked}.\nHow can I help you?`,
      accessToken: whatsappAccessToken,
    });
    return;
  }

  // ── Normal AI reply flow ────────────────────────────────────────────────────
  let greeting = "";
  if (!convo || isNewDay(convo.lastInteraction)) {
    greeting = detectLang(text) === "ar" ? "أهلًا 👋" : "Hi 👋";
  }

  let grouped = {};
  try { grouped = await retrieveChunks({ clientId: String(clientId), botType, userText: text, retrievalQuery: text, maxChunks: 8 }); }
  catch (e) { console.warn("⚠️ [worker/whatsapp] retrieveChunks failed:", e.message); }

  const rulesPrompt = buildRulesPrompt(client);
  const { messages: base } = buildChatMessages({ rulesPrompt, groupedChunks: grouped, userText: text, sectionsOrder });
  const messagesForAI = injectHistory(base, history);

  let assistantMessage = "";
  try { assistantMessage = await getChatCompletion(messagesForAI); }
  catch (err) {
    console.error("❌ [worker/whatsapp] AI error:", err.message);
    assistantMessage = "⚠️ I'm having trouble right now. Please try again shortly.";
  }

  const combined = greeting ? `${greeting}\n\n${assistantMessage}` : assistantMessage;
  const outboundAt = new Date();

  const updatedHistory = [
    ...history,
    { role: "user", content: text, createdAt: inboundAt },
    { role: "assistant", content: combined, createdAt: outboundAt },
  ];

  await saveConvoWhatsApp(db, clientId, fromDigits, updatedHistory, {
    lastMessage: combined.slice(0, 200), lastMessageAt: outboundAt, lastDirection: "out",
    awaitSource: clientAwaitSource, sourceChoice: sourceChoiceExisting, meta: convoMeta,
  });

  try {
    await sendWhatsAppText({ phoneNumberId: phoneIdStr, to: fromDigits, text: combined, accessToken: whatsappAccessToken });
  } catch (e) {
    console.error("❌ [worker/whatsapp] send failed:", e.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// START WORKER — export and call from server.js
// ═════════════════════════════════════════════════════════════════════════════

export function startWorker() {
  const worker = createWorker(async (job) => {
    if (job.name === "messenger") await processMessengerJob(job.data);
    else if (job.name === "instagram") await processInstagramJob(job.data);
    else if (job.name === "whatsapp") await processWhatsAppJob(job.data);
    else console.warn(`⚠️ [worker] Unknown job name: ${job.name}`);
  });

  console.log("✅ [worker] Message queue worker started (concurrency: 40) — messenger + instagram + whatsapp");
  return worker;
}