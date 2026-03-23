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

async function runBatch(count, makeJob) {
  const started = [];
  const finished = [];
  const failed = [];

  const jobs = Array.from({ length: count }, (_, i) => i + 1).map(async (n) => {
    const start = Date.now();
    started.push(n);

    try {
      await makeJob(n);
      const ms = Date.now() - start;
      finished.push(n);
      return { n, ms, ok: true };
    } catch (err) {
      const ms = Date.now() - start;
      failed.push(n);
      return {
        n,
        ms,
        ok: false,
        error: err?.message || String(err),
      };
    }
  });

  const results = await Promise.all(jobs);

  const finishedSet = new Set(finished);
  const failedSet = new Set(failed);

  const missing = [];
  for (let n = 1; n <= count; n++) {
    if (!finishedSet.has(n) && !failedSet.has(n)) {
      missing.push(n);
    }
  }

  const duplicateStarts = started.filter((n, i) => started.indexOf(n) !== i);
  const duplicateFinishes = finished.filter((n, i) => finished.indexOf(n) !== i);

  return {
    results,
    summary: stats(results.filter((r) => r.ok)),
    failedCount: failed.length,
    startedCount: started.length,
    finishedCount: finished.length,
    missingCount: missing.length,
    missing,
    duplicateStarts,
    duplicateFinishes,
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