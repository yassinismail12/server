import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function getChatCompletion(systemPrompt, userMessage) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: String(systemPrompt)
            },
            {
                role: "user",
                content: String(userMessage)
            }
        ],
    });

    return completion.choices[0].message.content; // already a string in v4
}
