import "dotenv/config";
import { processWhatsAppJob } from "./worker.js";
import mongoose from "mongoose";
import { connectToDB as connectDB } from "./services/db.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stats(results) {
  const times = results.map((x) => x.ms);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    count: times.length,
    avgMs: Math.round(sum / times.length),
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
  };
}

async function runBatch(count, makeJob) {
  console.log(`\n===== TEST ${count} MESSAGES =====`);

  const jobs = Array.from({ length: count }, (_, i) => i + 1).map(async (n) => {
    const start = Date.now();

    try {
      await makeJob(n);
      const end = Date.now();
      return { n, ms: end - start, ok: true };
    } catch (err) {
      const end = Date.now();
      return { n, ms: end - start, ok: false, error: err.message };
    }
  });

  const results = await Promise.all(jobs);

  results.forEach((r) => {
    if (r.ok) console.log(`Message ${r.n}: ${r.ms} ms`);
    else console.log(`Message ${r.n}: FAILED after ${r.ms} ms -> ${r.error}`);
  });

  const okOnly = results.filter((r) => r.ok);
  console.log("\nSummary:", stats(okOnly));

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`Failed: ${failed.length}`);
  }
}

async function main() {
  await connectDB();

  // IMPORTANT:
  // use a TEST clientId only
  // use fake/test phone numbers only
  // otherwise your code may send real WhatsApp replies

  const TEST_CLIENT_ID = "realestate"; // change this
  const TEST_PHONE_ID = "123456789";   // change this

  const makeWhatsAppJob = async (n) => {
    await processWhatsAppJob({
      clientId: TEST_CLIENT_ID,
      fromDigits: `201000000${String(n).padStart(3, "0")}`,
      text: `Test message ${n}`,
      whatsappPhoneNumberId: TEST_PHONE_ID,
    });
  };

  await runBatch(10, makeWhatsAppJob);
  await sleep(2000);

  await runBatch(50, makeWhatsAppJob);
  await sleep(3000);

  await runBatch(100, makeWhatsAppJob);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Load test crashed:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});