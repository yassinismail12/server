// utils/systemPrompt.js
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const dbName = "Agent";

/**
 * Gets the system prompt for a client, using either clientId (Web) or pageId (Messenger).
 * Automatically includes any files the client has.
 * 
 * @param {Object} params - Object containing either `clientId` or `pageId`
 * @returns {string} Final prompt ready for AI
 */
export async function SYSTEM_PROMPT({ clientId, pageId,igId }) {
    if (!client.topology || !client.topology.isConnected()) {
        await client.connect();
    }

    const db = client.db(dbName);
    const clients = db.collection("Clients");

    // Use pageId if provided, otherwise fall back to clientId
    let query = {};
    if (pageId) query = { pageId };
    else if (clientId) query = { clientId };
    else if (igId) query = { igId };


    const clientData = await clients.findOne(query);

    if (!clientData) throw new Error("Client not found");

    let finalPrompt = clientData.systemPrompt || "";

    // If client has files, append them to the system prompt
    if (clientData.files && clientData.files.length > 0) {
        const filesText = clientData.files
            .map(f => `--- File: ${f.name} ---\n${f.content}`)
            .join("\n\n");
        finalPrompt += `\n\n${filesText}`;
    }

    // Replace placeholders like {{faqs}}, {{listingsData}}, etc.
    for (const [key, value] of Object.entries(clientData)) {
        if (typeof value === "string" && finalPrompt) {
            finalPrompt = finalPrompt.replaceAll(`{{${key}}}`, value);
        }
    }

    return finalPrompt;
}
