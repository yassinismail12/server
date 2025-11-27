import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function getChatCompletion(history) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: history,
    });

    return completion.choices[0].message.content;
}
