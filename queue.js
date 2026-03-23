// queue.js
// BullMQ queue for scaling messenger, instagram, and whatsapp message processing.
// Uses Upstash Redis (free tier) or any Redis instance via env vars.
//
// Render env vars to set:
//   REDIS_HOST     → e.g. alive-xxx.upstash.io
//   REDIS_PORT     → 6379
//   REDIS_PASSWORD → your Upstash password
//   REDIS_TLS      → "true"  (required for Upstash)

import { Queue, Worker } from "bullmq";

// ─── Redis connection ─────────────────────────────────────────────────────────
const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  maxRetriesPerRequest: null, // required by BullMQ
};

// ─── Shared queue ─────────────────────────────────────────────────────────────
// One queue, three job names: "messenger", "instagram", "whatsapp"
export const messageQueue = new Queue("messages", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 }, // 2s → 4s → 8s on retry
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

// ─── Worker factory ───────────────────────────────────────────────────────────
// Called once from server.js after mongoose connects.
export function createWorker(processor) {
  const worker = new Worker("messages", processor, {
    connection,
    concurrency: 40, // 40 parallel jobs — handles ~1000 msgs/min comfortably
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

// ─── Safe jobId helper — BullMQ forbids colons in job IDs ────────────────────
function safeId(str) {
  return String(str || "").replace(/:/g, "-").replace(/[^a-zA-Z0-9_\-\.]/g, "").slice(0, 128);
}

// ─── Enqueue: Messenger ───────────────────────────────────────────────────────
export async function enqueueMessengerMessage({ pageId, sender_psid, userMessage, eventKey }) {
  const jobId = `msng-${safeId(pageId)}-${safeId(sender_psid)}-${safeId(eventKey || Date.now())}`;
  await messageQueue.add(
    "messenger",
    { pageId, sender_psid, userMessage, eventKey },
    { jobId }
  );
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
  const jobId = `ig-${safeId(igBusinessId)}-${safeId(senderId)}-${safeId(eventKey || Date.now())}`;
  await messageQueue.add(
    "instagram",
    { igBusinessId, senderId, userText, eventKey, clientId, pageId, pageToken },
    { jobId }
  );
}

// ─── Enqueue: WhatsApp ────────────────────────────────────────────────────────
export async function enqueueWhatsAppMessage({
  clientId,
  fromDigits,
  text,
  whatsappPhoneNumberId,
  msgId,
}) {
  const jobId = `wa-${safeId(clientId)}-${safeId(fromDigits)}-${safeId(msgId || Date.now())}`;
  await messageQueue.add(
    "whatsapp",
    { clientId, fromDigits, text, whatsappPhoneNumberId, msgId },
    { jobId }
  );
}