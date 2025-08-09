import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Keep a history per user (in-memory example — better to store in DB for production)
const userHistories = {};

export async function getChatCompletion(clientId, userId, systemPrompt, userMessage) {
    const key = `${clientId}:${userId}`;

    if (!userHistories[key]) {
        userHistories[key] = [
            { role: "system", content: String(systemPrompt) }
        ];
    }

    // Add the user's new message
    userHistories[key].push({ role: "user", content: String(userMessage) });

    // Send the entire history to OpenAI
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: userHistories[key],
    });

    const assistantMessage = completion.choices[0].message.content;

    // Store assistant's reply in history
    userHistories[key].push({ role: "assistant", content: assistantMessage });

    return assistantMessage;
}
