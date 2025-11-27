import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
    // Format messages for OpenAI API, handling both text and images
    // Images should already be in data URL format (data:image/...;base64,...) from web.js
    const formattedMessages = history.map(msg => {
        // Convert content to proper format for OpenAI Vision API
        let content;
        if (Array.isArray(msg.content)) {
            content = msg.content.map(item => {
                if (item.type === "text") {
                    return { type: "text", text: item.text || "" };
                } else if (item.type === "image_url") {
                    // Handle image URLs (including base64 data URLs)
                    // This format is required for GPT-4o Vision API
                    return {
                        type: "image_url",
                        image_url: {
                            url: item.image_url?.url || item.image_url || "",
                            detail: item.image_url?.detail || "auto"
                        }
                    };
                } else if (item.type === "input_image") {
                    // Legacy format support - convert to image_url format
                    return {
                        type: "image_url",
                        image_url: {
                            url: item.image_url || "",
                            detail: "auto"
                        }
                    };
                }
                // Fallback: convert unknown types to text
                return { type: "text", text: String(item) };
            });
        } else {
            // If content is not an array, convert to text format
            content = [{ type: "text", text: String(msg.content) }];
        }
        
        return {
            role: msg.role,
            content: content
        };
    });

    // Call OpenAI API with vision support (gpt-4o supports images)
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: formattedMessages
    });

    const assistant = response.choices[0].message;
    if (!assistant?.content) {
        return { text: "", imageUrls: [] };
    }

    // Extract text and image URLs from response
    let text = "";
    const imageUrls = [];

    // Handle response content - can be string or array (multimodal)
    if (typeof assistant.content === 'string') {
        text = assistant.content;
    } else if (Array.isArray(assistant.content)) {
        // Process multimodal response: extract text and image URLs
        assistant.content.forEach(c => {
            if (c.type === "text") {
                text += (text ? "\n" : "") + (c.text || "");
            } else if (c.type === "image_url" && c.image_url?.url) {
                // Extract image URLs from response
                imageUrls.push(c.image_url.url);
            }
        });
    } else {
        text = String(assistant.content);
    }

    // Also check for image URLs mentioned in the text (e.g., OpenAI might reference images)
    // Extract URLs from text that look like image URLs
    const urlPattern = /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)/gi;
    const textUrls = text.match(urlPattern) || [];
    textUrls.forEach(url => {
        if (!imageUrls.includes(url)) {
            imageUrls.push(url);
        }
    });

    // Return both text and image URLs
    return {
        text: text.trim(),
        imageUrls: imageUrls
    };
}