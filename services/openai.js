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

    const assistant = response.choices[0].message;
    if (!assistant?.content) return "";

    // Combine text and image responses
    return assistant.content.map(c => {
        if (c.type === "text") return c.text;
        if (c.type === "output_image") return c.image_url; // GPT returned an image
        return "";
    }).join("\n");
}
