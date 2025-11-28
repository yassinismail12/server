export async function getChatCompletion(history) {
    // Format messages for OpenAI API
    const formattedMessages = history.map(msg => {
        let content;
        if (Array.isArray(msg.content)) {
            content = msg.content.map(item => {
                if (item.type === "text") {
                    return { type: "text", text: item.text || "" };
                } else if (item.type === "image_url") {
                    return {
                        type: "image_url",
                        image_url: {
                            url: item.image_url?.url || item.image_url || "",
                            detail: item.image_url?.detail || "auto"
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
    if (!assistant?.content) {
        return { text: "", imageUrls: [] };
    }

    // SIMPLIFIED: Just extract text, don't look for image URLs
    let text = "";
    
    if (typeof assistant.content === 'string') {
        text = assistant.content;
    } else if (Array.isArray(assistant.content)) {
        // Only extract text content
        assistant.content.forEach(c => {
            if (c.type === "text") {
                text += (text ? "\n" : "") + (c.text || "");
            }
            // IGNORE image_url types - these are just your input images being echoed back
        });
    } else {
        text = String(assistant.content);
    }

    // Return empty imageUrls array since OpenAI doesn't generate images
    return {
        text: text.trim(),
        imageUrls: [] // Always empty - OpenAI Vision doesn't create images
    };
}