import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
  const response = await openai.responses.create({
    model: "gpt-4o",
    input: history,
  });

  return response;
}
