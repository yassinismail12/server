import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const dbName = "Agent";

export async function SYSTEM_PROMPT(clientId) {
    // Reuse connection if already established
    if (!client.topology || !client.topology.isConnected()) {
        await client.connect();
    }

    const db = client.db(dbName);
    const clients = db.collection("Clients");

    // Find client using clientId (not slug)
    const clientData = await clients.findOne({ clientId });

    if (!clientData) throw new Error("Client not found");

    let finalPrompt = clientData.systemPrompt;

    // Dynamically replace all {{key}} placeholders with values from clientData
    for (const [key, value] of Object.entries(clientData)) {
        if (typeof value === "string") {
            finalPrompt = finalPrompt.replaceAll(`{{${key}}}`, value);
        }
    }

    return finalPrompt;
}
