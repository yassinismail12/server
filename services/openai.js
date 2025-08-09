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
                content: [{ type: "text", text: String(systemPrompt) }]
            },
            {
                role: "user",
                content: [{ type: "text", text: String(userMessage) }]
            }
        ],
    });

    // OpenAI v4 returns content as an array — for plain text, grab the first item
    return completion.choices[0].message.content[0].text;
}
