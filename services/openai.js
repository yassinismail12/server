// services/openai.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const DEFAULT_TEMPERATURE = process.env.OPENAI_TEMPERATURE ? Number(process.env.OPENAI_TEMPERATURE) : 0.4;
const DEFAULT_MAX_OUTPUT_TOKENS = process.env.OPENAI_MAX_OUTPUT_TOKENS ? Number(process.env.OPENAI_MAX_OUTPUT_TOKENS) : 500;
const DEFAULT_TIMEOUT_MS = process.env.OPENAI_TIMEOUT_MS ? Number(process.env.OPENAI_TIMEOUT_MS) : 25000;

// Retry tuning
const OPENAI_RETRIES = process.env.OPENAI_RETRIES ? Number(process.env.OPENAI_RETRIES) : 3;
const OPENAI_RETRY_BASE_MS = process.env.OPENAI_RETRY_BASE_MS ? Number(process.env.OPENAI_RETRY_BASE_MS) : 600;
const OPENAI_RETRY_MAX_MS = process.env.OPENAI_RETRY_MAX_MS ? Number(process.env.OPENAI_RETRY_MAX_MS) : 8000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getStatus(err) {
  // OpenAI SDK errors often carry status on err.status / err.response?.status
  return err?.status ?? err?.response?.status ?? null;
}

function isRetryableOpenAI(err) {
  const status = getStatus(err);
  // Retry rate limits + transient server errors + timeouts/aborts/network
  if (status === 429) return true;
  if (status && status >= 500 && status <= 599) return true;

  const name = err?.name || "";
  const msg = (err?.message || "").toLowerCase();

  if (name.includes("AbortError")) return true;
  if (msg.includes("aborted")) return true;
  if (msg.includes("timeout")) return true;
  if (msg.includes("network")) return true;
  if (msg.includes("fetch")) return true;

  return false;
}

function computeBackoffMs(attempt) {
  const exp = Math.min(OPENAI_RETRY_MAX_MS, OPENAI_RETRY_BASE_MS * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250); // helps avoid sync retry storms
  return exp + jitter;
}

async function callOpenAIOnce(messages) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const completion = await openai.chat.completions.create(
      {
        model: DEFAULT_MODEL,
        messages,
        temperature: DEFAULT_TEMPERATURE,
        max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      },
      { signal: controller.signal }
    );
    return completion?.choices?.[0]?.message?.content?.trim() || "";
  } finally {
    clearTimeout(t);
  }
}

export async function getChatCompletion(messages) {
  let lastErr;

  for (let attempt = 0; attempt <= OPENAI_RETRIES; attempt++) {
    try {
      return await callOpenAIOnce(messages);
    } catch (err) {
      lastErr = err;

      // If not retryable or no attempts left, throw with useful info
      const retryable = isRetryableOpenAI(err);
      const status = getStatus(err);

      if (!retryable || attempt === OPENAI_RETRIES) {
        const name = err?.name || "OpenAIError";
        const msg = err?.message || String(err);
        // Keep status in message for logs
        throw new Error(`${name}${status ? ` (status ${status})` : ""}: ${msg}`);
      }

      const wait = computeBackoffMs(attempt);
      console.log(`OpenAI retry ${attempt + 1}/${OPENAI_RETRIES} in ${wait}ms`, {
        status,
        err: err?.message,
      });
      await sleep(wait);
    }
  }

  // Should never reach here
  throw lastErr;
}
