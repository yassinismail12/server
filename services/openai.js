import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function getChatCompletion(history) {
  const completion = await openai.chat.completions.create({
    model:      "gpt-4o",
    messages:   history,
    max_tokens: 1000,       // ✅ prevents runaway long replies burning credits
    temperature: 0.4,       // ✅ lower = more factual, less hallucination
  });

  return completion.choices[0].message.content;
}