// openai.js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function getChatCompletion(history) {
  // For GPT-4o, we can send the content array directly
  const formattedMessages = history.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: formattedMessages,
  });

  // The response content is already a string
  return response.choices[0].message.content;
}