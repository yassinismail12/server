import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Convert your internal content array into plain text for OpenAI
function flattenMessage(msg) {
  if (!Array.isArray(msg.content)) return String(msg.content);

  // Combine all text content into a single string
  return msg.content
    .map(c => {
      if (c.type === "text") return c.text;
      if (c.type === "input_image") return `[Image: ${c.image_url}]`; // placeholder text
      return String(c);
    })
    .join("\n");
}

export async function getChatCompletion(history) {
  const formattedMessages = history.map(msg => ({
    role: msg.role,
    content: flattenMessage(msg),
  }));

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: formattedMessages,
  });

  return response.choices[0].message.content;
}
