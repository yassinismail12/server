export async function getChatCompletion(history) {
  // strip any extra fields like createdAt
  const messages = history.map(h => ({
    role: h.role,
    content: typeof h.content === "string" ? h.content : JSON.stringify(h.content)
  }));

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: messages
  });

  return response;
}
