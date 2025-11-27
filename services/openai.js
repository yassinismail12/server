export async function getChatCompletion(history) {
  if (!history || !history.length) {
    throw new Error("History is empty.");
  }

  const input = [];

  history.forEach(h => {
    if (!h.content) return;

    // If content is string, push as text
    if (typeof h.content === "string") {
      input.push({ type: "input_text", text: h.content });
    }
    // If content is array
    else if (Array.isArray(h.content)) {
      h.content.forEach(c => {
        if (typeof c === "string") {
          input.push({ type: "input_text", text: c });
        } else if (c.type === "input_text" && c.text) {
          input.push({ type: "input_text", text: c.text });
        } else if (c.type === "input_image" && c.image_url) {
          input.push({ type: "input_image", image_url: c.image_url });
        }
      });
    }
    // If content is already a single object with type
    else if (h.content.type === "input_text" && h.content.text) {
      input.push({ type: "input_text", text: h.content.text });
    } else if (h.content.type === "input_image" && h.content.image_url) {
      input.push({ type: "input_image", image_url: h.content.image_url });
    }
  });

  if (!input.length) {
    throw new Error("No valid input to send to OpenAI.");
  }

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
