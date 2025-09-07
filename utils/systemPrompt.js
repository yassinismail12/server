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
    if (!client.topology?.isConnected()) await client.connect();
    const db = client.db("Agent");
    const clients = db.collection("Clients");

    let clientData;
    if (pageId) {
        clientData = await clients.findOne({ pageId: pageId.toString().trim() });
        if (!clientData) throw new Error(`Messenger client not found for pageId: ${pageId}`);
    } else if (clientId) {
        clientData = await clients.findOne({ clientId });
        if (!clientData) throw new Error(`Web client not found for clientId: ${clientId}`);
    } else {
        throw new Error("SYSTEM_PROMPT: either pageId or clientId must be provided");
    }

    let finalPrompt = clientData.systemPrompt;
    for (const [key, value] of Object.entries(clientData)) {
        if (typeof value === "string" && finalPrompt) {
            finalPrompt = finalPrompt.replaceAll(`{{${key}}}`, value);
        }
    }

    return finalPrompt;
}
