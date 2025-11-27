import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function getChatCompletion(history) {
  if (!history || !history.length) {
    throw new Error("History is empty.");
  }

  // Build input array
  const input = [];

  history.forEach(h => {
    if (!h.content) return;

    if (typeof h.content === "string") {
      input.push({ type: "input_text", text: h.content });
    } else if (Array.isArray(h.content)) {
      h.content.forEach(c => {
        if (typeof c === "string") input.push({ type: "input_text", text: c });
        else if (c.type === "input_image" && c.image_url) input.push({ type: "input_image", image_url: c.image_url });
      });
    }
  });

  if (!input.length) {
    throw new Error("No valid input to send to OpenAI.");
  }

  // Call OpenAI Responses API
  const response = await openai.responses.create({
    model: "gpt-4o",
    input
  });

  let text = "";
  let images = [];

  if (response.output) {
    for (const item of response.output) {
      if (item.type === "output_text" && item.text) text += item.text;
      else if (item.type === "output_image" && item.image_url) images.push(item.image_url);
    }
  }

  return { text, images };
}
