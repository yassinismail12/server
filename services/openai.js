import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
  // Map history to valid OpenAI input format
  const messagesForOpenAI = history.map(h => ({
    role: h.role,
    content: Array.isArray(h.content)
      ? h.content.map(c => {
          if (typeof c === "string") return { type: "input_text", text: c };
          if (c.type === "input_image") return { type: "input_image", image_url: c.image_url };
          return { type: "input_text", text: c.text || "" };
        })
      : [{ type: "input_text", text: h.content }]
  }));

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
