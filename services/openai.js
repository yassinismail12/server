import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
    // Strip extra fields: only send role + content
    const messagesForOpenAI = history.map(h => ({ role: h.role, content: h.content }));

    const response = await openai.responses.create({
        model: "gpt-4o",
        input: messagesForOpenAI
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
