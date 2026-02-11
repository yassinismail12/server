// services/queue.js
import { Queue } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.warn("⚠️ REDIS_URL is not set. Queue will not work until you configure Redis.");
}

export const queueName = process.env.QUEUE_NAME || "message-jobs";

let connection = null;
let messageQueue = null;

export function getRedisConnection() {
  if (!REDIS_URL) return null;
  if (connection) return connection;

  connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connection.on("connect", () => console.log("✅ Redis connected"));
  connection.on("error", (err) => console.error("❌ Redis error:", err?.message || err));

  return connection;
}

export function getMessageQueue() {
  if (messageQueue) return messageQueue;

  const conn = getRedisConnection();
  if (!conn) throw new Error("REDIS_URL missing. Cannot create BullMQ queue.");

  messageQueue = new Queue(queueName, {
    connection: conn,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1500 },
      removeOnComplete: 2000,
      removeOnFail: 5000,
    },
  });

  return messageQueue;
}

/**
 * Enqueue a message processing job.
 * @param {object} payload - job data
 * @param {string} payload.channel - "messenger" | "whatsapp" | "web"
 * @param {string} payload.clientId - your tenant/client id
 * @param {string} payload.eventKey - unique id for dedupe
 */
export async function enqueueMessageJob(payload) {
  const q = getMessageQueue();

  const eventKey = payload.eventKey || `${payload.channel}:${Date.now()}:${Math.random()}`;
  const jobId = eventKey; // IMPORTANT: makes jobs idempotent in BullMQ

  try {
    const job = await q.add("process-message", payload, { jobId });
    return { ok: true, jobId: job.id };
  } catch (err) {
    // If job already exists (duplicate), BullMQ throws. That's fine.
    if (String(err?.message || "").includes("Job already exists")) {
      return { ok: true, jobId, deduped: true };
    }
    console.error("❌ enqueueMessageJob failed:", err);
    return { ok: false, error: err?.message || "enqueue failed" };
  }
}
