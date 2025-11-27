import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
    // Ensure all messages have content as array of objects
    const formattedMessages = history.map(msg => ({
        role: msg.role,
        content: Array.isArray(msg.content)
            ? msg.content
            : [{ type: "text", text: String(msg.content) }],
    }));

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: formattedMessages
    });

    // Combine text content from assistant message
    const assistant = response.choices[0].message;
    if (!assistant?.content) return "";
    return assistant.content.map(c => c.text || "").join("\n");
}
