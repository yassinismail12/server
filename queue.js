// queue.js
// Bulletproof BullMQ setup with ZERO Redis errors if not configured

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

// ─────────────────────────────────────────────────────────────────────────────
// 🧠 Detect Redis safely
// ─────────────────────────────────────────────────────────────────────────────

const redisUrl = String(process.env.REDIS_URL || "").trim();

// Only enable if it's a REAL URL (not empty / not localhost default)
const hasRedis =
  redisUrl &&
  redisUrl.startsWith("redis://") &&
  !redisUrl.includes("127.0.0.1");

// ─────────────────────────────────────────────────────────────────────────────
// 🔌 Connection (SAFE)
// ─────────────────────────────────────────────────────────────────────────────

let connection = null;
let messageQueue = null;

if (hasRedis) {
  try {
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    connection.on("error", (err) => {
      console.error("❌ Redis connection error:", err.message);
    });

    messageQueue = new Queue("messages", {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });

    console.log("✅ Queue enabled (Redis connected)");
  } catch (err) {
    console.error("❌ Redis init failed → fallback to direct mode:", err.message);
    messageQueue = null;
  }
} else {
  console.log("⚠️ Queue disabled (no valid REDIS_URL) → using direct processing");
}

export { messageQueue };

// ─────────────────────────────────────────────────────────────────────────────
// 🏗 Worker factory (SAFE)
// ─────────────────────────────────────────────────────────────────────────────

export function createWorker(processor) {
  if (!messageQueue || !connection) {
    console.log("⚠️ Worker not started (no Redis)");
    return null;
  }

  const worker = new Worker("messages", processor, {
    connection,
    concurrency: 5,
    lockDuration: 60000,
  });

  worker.on("completed", (job) => {
    console.log(`✅ [queue] Job ${job.id} (${job.name}) completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`❌ [queue] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("❌ [queue] Worker error:", err.message);
  });

  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🧩 Helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeShort(str, maxLen = 20) {
  return String(str || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, maxLen);
}

function uniqueTail(eventKey) {
  return String(eventKey || Date.now())
    .slice(-40)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// 🚀 Safe enqueue (queue OR direct fallback)
// ─────────────────────────────────────────────────────────────────────────────

async function addOrFallback(jobName, payload, jobId, fallbackProcessor) {
  // 🔥 Always fallback if queue disabled
  if (!messageQueue) {
    await fallbackProcessor(payload);
    return { mode: "direct" };
  }

  try {
    await messageQueue.add(jobName, payload, { jobId });
    return { mode: "queued" };
  } catch (err) {
    console.error(`❌ [queue] enqueue failed → fallback`, err.message);

    await fallbackProcessor(payload);
    return { mode: "direct-fallback" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 📩 Messenger
// ─────────────────────────────────────────────────────────────────────────────

export async function enqueueMessengerMessage({
  pageId,
  sender_psid,
  userMessage,
  eventKey,
}) {
  const { processMessengerDirect } = await import("./worker.js");

  const payload = { pageId, sender_psid, userMessage, eventKey };
  const jobId = `msng-${safeShort(pageId)}-${safeShort(sender_psid)}-${uniqueTail(eventKey)}`;

  return addOrFallback("messenger", payload, jobId, processMessengerDirect);
}

// ─────────────────────────────────────────────────────────────────────────────
// 📸 Instagram
// ─────────────────────────────────────────────────────────────────────────────

export async function enqueueInstagramMessage({
  igBusinessId,
  senderId,
  userText,
  eventKey,
  clientId,
  pageId,
  pageToken,
}) {
  const { processInstagramDirect } = await import("./worker.js");

  const payload = {
    igBusinessId,
    senderId,
    userText,
    eventKey,
    clientId,
    pageId,
    pageToken,
  };

  const jobId = `ig-${safeShort(igBusinessId)}-${safeShort(senderId)}-${uniqueTail(eventKey)}`;

  return addOrFallback("instagram", payload, jobId, processInstagramDirect);
}

// ─────────────────────────────────────────────────────────────────────────────
// 💬 WhatsApp
// ─────────────────────────────────────────────────────────────────────────────

export async function enqueueWhatsAppMessage({
  clientId,
  fromDigits,
  text,
  whatsappPhoneNumberId,
  msgId,
}) {
  const { processWhatsAppDirect } = await import("./worker.js");

  const payload = {
    clientId,
    fromDigits,
    text,
    whatsappPhoneNumberId,
    msgId,
  };

  const jobId = `wa-${safeShort(clientId)}-${safeShort(fromDigits)}-${uniqueTail(msgId)}`;

  return addOrFallback("whatsapp", payload, jobId, processWhatsAppDirect);
}