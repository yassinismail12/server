import { OpenAI } from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function getChatCompletion(systemPrompt, userMessage) {
    // Debug logs to make sure your system prompt and user message are correct


    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
        ],
    });

    return completion.choices[0].message.content;
}
