import express from "express";
import { processMessengerJob } from "../worker.js";

const router = express.Router();

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

async function runBatch(count) {
  const makeMessengerJob = async (n) => {
    await processMessengerJob({
      pageId: process.env.TEST_PAGE_ID,
      sender_psid: `test-user-${n}-${Date.now()}`,
      userMessage: `Test message ${n}`,
      eventKey: `test-${Date.now()}-${n}-${Math.random().toString(36).slice(2)}`,
    });
  };

  const jobs = Array.from({ length: count }, (_, i) => i + 1).map(async (n) => {
    const start = Date.now();

    try {
      await makeMessengerJob(n);
      return { n, ms: Date.now() - start, ok: true };
    } catch (err) {
      return {
        n,
        ms: Date.now() - start,
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

router.post("/load-test/:count", async (req, res) => {
  try {
    const count = Number(req.params.count);

    if (![10, 50, 100].includes(count)) {
      return res.status(400).json({
        ok: false,
        error: "Count must be 10, 50, or 100",
      });
    }

    const batch = await runBatch(count);

    return res.json({
      ok: true,
      count,
      ...batch,
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