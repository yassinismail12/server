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
            : [{ type: "text", text: String(msg.content) }],
    }));

    // Trim large messages or images
    formattedMessages.forEach(m => {
        m.content = m.content.map(c => {
            if (c.type === "text" && c.text.length > 2000) {
                // truncate very long text
                c.text = c.text.slice(-2000);
            }
            return c;
        });
    });

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: formattedMessages
    });

    const assistantContent = response.choices[0].message.content;

    // Convert to single string
    let replyText = "";
    for (const block of assistantContent) {
        if (block.type === "text") replyText += block.text;
        else if (block.type === "input_image") replyText += "\n[Image]";
    }

    return replyText;
}
