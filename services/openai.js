import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RETRYABLE_CODES = new Set(["rate_limit_exceeded", "server_error"]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getChatCompletion(messages, retries = 3) {
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        max_tokens: 1000,
        temperature: 0.4,
      });

      return completion.choices[0].message.content;
    } catch (err) {
      lastErr = err;

      const status = err?.status ?? err?.response?.status ?? 0;
      const code = err?.error?.code ?? err?.code ?? "";
      const isRetryable = RETRYABLE_STATUSES.has(status) || RETRYABLE_CODES.has(code);

      if (!isRetryable || attempt === retries) break;

      // exponential back-off: 1s, 2s, 4s
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(`⚠️ OpenAI attempt ${attempt} failed (${status || code}). Retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }

  // surface a clean error upstream — callers handle the user message
  const msg = lastErr?.message ?? String(lastErr ?? "Unknown OpenAI error");
  const wrapped = new Error(`OpenAI error after ${retries} attempts: ${msg}`);
  wrapped.original = lastErr;
  throw wrapped;
}