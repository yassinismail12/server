import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function getChatCompletion(history) {
    // Ensure all messages have content as array of objects
    const formattedMessages = history.map(msg => ({
        role: msg.role,
        content: Array.isArray(msg.content)
            ? msg.content
            : [{ type: "text", text: msg.content }],
    }));

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: formattedMessages
    });

    // Extract assistant text reply as a string
    const assistantContent = response.choices[0].message.content;

    // Join all text segments
    let replyText = "";
    for (const block of assistantContent) {
        if (block.type === "text") replyText += block.text;
        else if (block.type === "input_image") replyText += "\n[Image]";
    }

    return replyText;
}
