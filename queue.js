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
// attempts: 1 — errors handled inside processors with guaranteed replies.
export const messageQueue = new Queue("messages", {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

// ─── Worker factory ───────────────────────────────────────────────────────────
export function createWorker(processor) {
  const worker = new Worker("messages", processor, {
    connection,
    concurrency: 40,
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
// IG eventKeys are long base64 strings like:
//   mid:aWdfZAG1faXRlbToxOklHTWVz...NAZDZD
// They all share the same long prefix — only the LAST ~30 chars are unique.
// Slicing to 128 from the START causes collisions → jobs silently dropped.
// Fix: use the TAIL of the eventKey (the unique part) for the jobId.

function safeShort(str, maxLen = 20) {
  return String(str || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, maxLen);
}

function uniqueTail(eventKey) {
  // Take last 40 chars of the eventKey — this is where IG MIDs differ
  return String(eventKey || Date.now()).slice(-40).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
}

// ─── Enqueue: Messenger ───────────────────────────────────────────────────────
export async function enqueueMessengerMessage({ pageId, sender_psid, userMessage, eventKey }) {
  const jobId = `msng-${safeShort(pageId)}-${safeShort(sender_psid)}-${uniqueTail(eventKey)}`;
  await messageQueue.add(
    "messenger",
    { pageId, sender_psid, userMessage, eventKey },
    { jobId, delay: 300 }
  );
}

// ─── Enqueue: Instagram ───────────────────────────────────────────────────────
// Uses tail of eventKey to avoid jobId collisions on long IG MIDs.
export async function enqueueInstagramMessage({
  igBusinessId,
  senderId,
  userText,
  eventKey,
  clientId,
  pageId,
  pageToken,
}) {
  const jobId = `ig-${safeShort(igBusinessId)}-${safeShort(senderId)}-${uniqueTail(eventKey)}`;
  await messageQueue.add(
    "instagram",
    { igBusinessId, senderId, userText, eventKey, clientId, pageId, pageToken },
    { jobId, delay: 300 }
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
  const jobId = `wa-${safeShort(clientId)}-${safeShort(fromDigits)}-${uniqueTail(msgId)}`;
  await messageQueue.add(
    "whatsapp",
    { clientId, fromDigits, text, whatsappPhoneNumberId, msgId },
    { jobId, delay: 300 }
  );
}