import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
  // Convert conversation history into a single string prompt
  const prompt = history
    .map(h => {
      const role = h.role;
      const content = Array.isArray(h.content)
        ? h.content.map(c => (typeof c === "string" ? c : c.text || "")).join("\n")
        : h.content;
      return `${role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: prompt
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
