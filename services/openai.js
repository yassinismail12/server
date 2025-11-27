import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
    // Ensure all messages have content as array of objects with correct format
    const formattedMessages = history.map(msg => {
        // Convert content to proper format
        let content;
        if (Array.isArray(msg.content)) {
            content = msg.content.map(item => {
                if (item.type === "text") {
                    return { type: "text", text: item.text };
                } else if (item.type === "input_image") {
                    // Correct format for GPT-4o vision
                    return {
                        type: "image_url",
                        image_url: {
                            url: item.image_url,
                            detail: "auto"
                        }
                    };
                }
                return { type: "text", text: String(item) };
            });
        } else {
            content = [{ type: "text", text: String(msg.content) }];
        }
        
        return {
            role: msg.role,
            content: content
        };
    });

    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: formattedMessages
    });

    const assistant = response.choices[0].message;
    if (!assistant?.content) return "";

    // Handle response content (should be text for gpt-4o)
    if (typeof assistant.content === 'string') {
        return assistant.content;
    }
    
    // If it's an array (multimodal response), extract text
    if (Array.isArray(assistant.content)) {
        return assistant.content
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join("\n");
    }
    
    return String(assistant.content);
}