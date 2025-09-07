// utils/systemPrompt.js

import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const dbName = "Agent";

/**
 * Gets the system prompt for a client, using either clientId (Web) or pageId (Messenger).
 * 
 * @param {Object} params - Object containing either `clientId` or `pageId`
 * @returns {string} Final prompt with {{placeholders}} replaced
 */
export async function SYSTEM_PROMPT({ clientId, pageId }) {
    if (!client.topology || !client.topology.isConnected()) {
        await client.connect();
    }

    const db = client.db(dbName);
    const clients = db.collection("Clients");

    // Use pageId if provided, otherwise fall back to clientId
    const query = pageId ? { pageId } : { clientId };

    const clientData = await clients.findOne(query);

    if (!clientData) throw new Error("Client not found");

    let finalPrompt = clientData.systemPrompt;

    for (const [key, value] of Object.entries(clientData || {})) {
        if (typeof value === "string") {
            finalPrompt = finalPrompt.replaceAll(`{{${key}}}`, value);
        }
    }

    // Remove any leftover placeholders like {{something}}
    finalPrompt = finalPrompt.replace(/\{\{.*?\}\}/g, "");

    return finalPrompt;
}
