import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Converts conversation history into valid OpenAI Responses API input
 */
export async function getChatCompletion(history) {
  const messagesForOpenAI = [];

  history.forEach(h => {
    if (h.role === "system") {
      if (typeof h.content === "string") {
        messagesForOpenAI.push({ type: "input_text", text: h.content });
      } else if (Array.isArray(h.content)) {
        h.content.forEach(c => {
          if (typeof c === "string") messagesForOpenAI.push({ type: "input_text", text: c });
          else if (c.type === "input_image") messagesForOpenAI.push(c);
        });
      }
    } else if (h.role === "user") {
      if (typeof h.content === "string") messagesForOpenAI.push({ type: "input_text", text: h.content });
      else if (Array.isArray(h.content)) {
        h.content.forEach(c => {
          if (typeof c === "string") messagesForOpenAI.push({ type: "input_text", text: c });
          else if (c.type === "input_image") messagesForOpenAI.push(c);
        });
      }
    } else if (h.role === "assistant") {
      if (typeof h.content === "string") messagesForOpenAI.push({ type: "input_text", text: h.content });
      else if (Array.isArray(h.content)) {
        h.content.forEach(c => {
          if (typeof c === "string") messagesForOpenAI.push({ type: "input_text", text: c });
        });
      }
    }
  });

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: messagesForOpenAI
  });

  let text = "";
  let images = [];

  if (response.output) {
    for (const item of response.output) {
      if (item.type === "output_text") text += item.text;
      else if (item.type === "output_image") images.push(item.image_url);
    }
  }

  return { text, images };
}
