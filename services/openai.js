// openai.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
    // Use gpt-4o-mini or gpt-4o with structured output if you want images
    const response = await openai.responses.create({
        model: "gpt-4o",
        input: history
    });

    let text = "";
    let images = [];

    if (response.output) {
        for (const item of response.output) {
            if (item.type === "output_text") text += item.text;
            if (item.type === "output_image") images.push(item.image_url);
        }
    }

    return { text, images };
}
