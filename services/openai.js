// services/openai.js
import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function getChatCompletion(history) {
    const response = await openai.chat.completions.create({
        model: "gpt-4o", // supports images natively
        messages: history
    });

    return response.choices[0].message.content;
}
