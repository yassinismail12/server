import Client from "../Client.js";

function safeText(value = "") {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function joinBlocks(...parts) {
  return parts.map(safeText).filter(Boolean).join("\n\n").trim();
}

function buildFallbackPromptFromClient(client = {}) {
  const promptConfig = client.promptConfig || {};
  const business = client.businessData || client.business || {};

  const businessName =
    safeText(business.businessName) ||
    safeText(client.businessName) ||
    safeText(promptConfig.businessName);

  const businessType =
    safeText(business.businessType) ||
    safeText(client.businessType) ||
    safeText(promptConfig.businessType);

  const city =
    safeText(business.city) ||
    safeText(client.city) ||
    safeText(promptConfig.city);

  const area =
    safeText(business.area) ||
    safeText(client.area) ||
    safeText(promptConfig.area);

  const address =
    safeText(business.address) ||
    safeText(client.address) ||
    safeText(promptConfig.address);

  const location =
    safeText(business.location) ||
    safeText(client.location) ||
    safeText(promptConfig.location);

  const phone =
    safeText(business.phone) ||
    safeText(client.phone) ||
    safeText(promptConfig.phone);

  const whatsapp =
    safeText(business.whatsapp) ||
    safeText(client.whatsapp) ||
    safeText(promptConfig.whatsapp);

  const email =
    safeText(business.email) ||
    safeText(client.email) ||
    safeText(promptConfig.email);

  const hours =
    safeText(business.hours) ||
    safeText(business.workingHours) ||
    safeText(client.hours) ||
    safeText(promptConfig.hours);

  const services =
    safeText(business.services) ||
    safeText(client.services) ||
    safeText(promptConfig.services);

  const pricing =
    safeText(business.pricing) ||
    safeText(client.pricing) ||
    safeText(promptConfig.pricing);

  const menu =
    safeText(business.menu) ||
    safeText(client.menu) ||
    safeText(promptConfig.menu);

  const delivery =
    safeText(business.delivery) ||
    safeText(client.delivery) ||
    safeText(promptConfig.delivery);

  const policies =
    safeText(business.policies) ||
    safeText(client.policies) ||
    safeText(promptConfig.policies);

  const faqs =
    safeText(business.faqs) ||
    safeText(client.faqs) ||
    safeText(promptConfig.faqs);

  const customPrompt = safeText(client.systemPrompt);

  const businessLines = [
    "BUSINESS KNOWLEDGE",
    businessName ? `Business Name: ${businessName}` : null,
    businessType ? `Business Type: ${businessType}` : null,
    city ? `City: ${city}` : null,
    area ? `Area: ${area}` : null,
    address ? `Address: ${address}` : null,
    location ? `Location: ${location}` : null,
    phone ? `Phone: ${phone}` : null,
    whatsapp ? `WhatsApp: ${whatsapp}` : null,
    email ? `Email: ${email}` : null,
    hours ? `Working Hours: ${hours}` : null,
    services ? `Services: ${services}` : null,
    pricing ? `Pricing: ${pricing}` : null,
    menu ? `Menu: ${menu}` : null,
    delivery ? `Delivery: ${delivery}` : null,
    policies ? `Policies: ${policies}` : null,
    faqs ? `FAQs: ${faqs}` : null,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  return joinBlocks(customPrompt, businessLines);
}

export async function retrieveChunks({ clientId, botType = "default", userText } = {}) {
  const safeClientId = safeText(clientId);
  const safeBotType = safeText(botType) || "default";
  const safeUserText = safeText(userText);

  if (!safeClientId) {
    return {
      mode: "single_prompt",
      finalSystemPrompt: "",
      userText: safeUserText,
      hasPrompt: false,
      source: "missing_client_id",
    };
  }

  const client =
    (await Client.findOne({ clientId: safeClientId, botType: safeBotType }).lean()) ||
    (await Client.findOne({ clientId: safeClientId }).lean());

  if (!client) {
    return {
      mode: "single_prompt",
      finalSystemPrompt: "",
      userText: safeUserText,
      hasPrompt: false,
      source: "client_not_found",
    };
  }

  const finalSystemPrompt = joinBlocks(
    client.finalSystemPrompt,
    !safeText(client.finalSystemPrompt) ? client.systemPrompt : "",
    !safeText(client.finalSystemPrompt) && !safeText(client.systemPrompt)
      ? client.businessKnowledgePrompt
      : "",
    !safeText(client.finalSystemPrompt) &&
      !safeText(client.systemPrompt) &&
      !safeText(client.businessKnowledgePrompt)
      ? buildFallbackPromptFromClient(client)
      : ""
  );

  return {
    mode: "single_prompt",
    finalSystemPrompt,
    userText: safeUserText,
    hasPrompt: Boolean(finalSystemPrompt),
    source: safeText(client.finalSystemPrompt)
      ? "finalSystemPrompt"
      : safeText(client.systemPrompt)
      ? "systemPrompt"
      : safeText(client.businessKnowledgePrompt)
      ? "businessKnowledgePrompt"
      : "fallback_from_client_fields",
  };
}

export default retrieveChunks;