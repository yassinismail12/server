export function buildDataBlock(groupedChunks, sectionsOrder) {
  return sectionsOrder.map(section => {
    const items = groupedChunks[section] || [];
    const body = items.length ? items.map(x => x.text).join("\n") : "No relevant data found.";
    return `${section.toUpperCase()}\n\n${body}`;
  }).join("\n\n");
}

export function buildChatMessages({ rulesPrompt, groupedChunks, userText, sectionsOrder }) {
  const dataBlock = buildDataBlock(groupedChunks, sectionsOrder);

  return [
    { role: "system", content: rulesPrompt },
    { role: "user", content: `${dataBlock}\n\nUser message:\n${userText}` }
  ];
}
