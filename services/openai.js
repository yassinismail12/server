// services/openai.js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const DEFAULT_TEMPERATURE = process.env.OPENAI_TEMPERATURE
  ? Number(process.env.OPENAI_TEMPERATURE)
  : 0.4;

// Optional: hard cap output tokens to avoid runaway costs
const DEFAULT_MAX_OUTPUT_TOKENS = process.env.OPENAI_MAX_OUTPUT_TOKENS
  ? Number(process.env.OPENAI_MAX_OUTPUT_TOKENS)
  : 500;

// Optional: request timeout (ms)
const DEFAULT_TIMEOUT_MS = process.env.OPENAI_TIMEOUT_MS
  ? Number(process.env.OPENAI_TIMEOUT_MS)
  : 25000;

export async function getChatCompletion(messages) {
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
  } catch (err) {
    // Surface useful errors to logs; caller handles fallback message
    const name = err?.name || "OpenAIError";
    const msg = err?.message || String(err);
    throw new Error(`${name}: ${msg}`);
  } finally {
    clearTimeout(t);
  }
}
