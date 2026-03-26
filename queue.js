// queue.js
// BullMQ queue for scaling messenger, instagram, and whatsapp message processing.
// Uses Upstash Redis (free tier) or any Redis instance via env vars.

import { Queue, Worker } from "bullmq";

// ─── Redis connection ─────────────────────────────────────────────────────────
const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  maxRetriesPerRequest: null,
};

// ─── Shared queue ─────────────────────────────────────────────────────────────
export const messageQueue = new Queue("messages", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

// ─── Worker factory ───────────────────────────────────────────────────────────
export function createWorker(processor) {
  const worker = new Worker("messages", processor, {
    connection,
    concurrency: 5,
    lockDuration: 60000,
  });

  worker.on("completed", (job) => {
    console.log(`✅ [queue] Job ${job.id} (${job.name}) completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`❌ [queue] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("❌ [queue] Worker error:", err.message);
  });

  return worker;
}

// ─── JobId helpers ────────────────────────────────────────────────────────────

function safeShort(str, maxLen = 20) {
  return String(str || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, maxLen);
}

function uniqueTail(eventKey) {
  return String(eventKey || Date.now())
    .slice(-40)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 40);
}

// ─── Generic safe enqueue helper ─────────────────────────────────────────────

async function addOrFallback(jobName, payload, jobId, fallbackProcessor) {
  try {
    await messageQueue.add(jobName, payload, { jobId });
    return { mode: "queued" };
  } catch (err) {
    console.error(`❌ [queue] enqueue failed for ${jobName}, using direct fallback:`, err.message);

    try {
      await fallbackProcessor(payload);
      return { mode: "direct-fallback" };
    } catch (fallbackErr) {
      console.error(`❌ [queue] direct fallback also failed for ${jobName}:`, fallbackErr.message);
      throw fallbackErr;
    }
  }
}

// ─── Enqueue: Messenger ───────────────────────────────────────────────────────
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

// ─── Enqueue: Instagram ───────────────────────────────────────────────────────
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

// ─── Enqueue: WhatsApp ────────────────────────────────────────────────────────
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