import express from "express";
import { processMessengerJob } from "../worker.js";

const router = express.Router();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stats(results) {
  if (!results.length) {
    return { count: 0, avgMs: 0, minMs: 0, maxMs: 0 };
  }

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
  const jobs = Array.from({ length: count }, (_, i) => i + 1).map(async (n) => {
    const start = Date.now();

    try {
      await makeJob(n);
      const end = Date.now();
      return { n, ms: end - start, ok: true };
    } catch (err) {
      const end = Date.now();
      return {
        n,
        ms: end - start,
        ok: false,
        error: err?.message || String(err),
      };
    }
  });

  const results = await Promise.all(jobs);

  return {
    results,
    summary: stats(results.filter((r) => r.ok)),
    failed: results.filter((r) => !r.ok).length,
  };
}

router.post("/load-test", async (req, res) => {
  try {
    const testClientId = process.env.LOAD_TEST_CLIENT_ID || "realestate";
    const testPhoneId = process.env.LOAD_TEST_PHONE_ID || "123456789";

   const makeMessengerJob = async (n) => {
  await processMessengerJob({
    pageId: process.env.TEST_PAGE_ID,        // your FB page ID
    sender_psid: `test-user-${n}`,           // fake user
    userMessage: `Test message ${n}`,
    eventKey: `test-${Date.now()}-${n}`,     // unique
  });
};
const batch10 = await runBatch(10, makeMessengerJob);
await sleep(2000);

const batch50 = await runBatch(50, makeMessengerJob);
await sleep(3000);

const batch100 = await runBatch(100, makeMessengerJob);
    return res.json({
      ok: true,
      testClientId,
      batch10,
      batch50,
      batch100,
    });
  } catch (err) {
    console.error("Load test route failed:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

export default router;