import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const dbName = "Agent";

export async function SYSTEM_PROMPT(slug) {
    if (!client.topology?.isConnected()) {
        await client.connect();
    }

    const db = client.db(dbName);
    const clients = db.collection("Clients");

    const clientData = await clients.findOne({ slug });

    if (!clientData) throw new Error("Client not found");

    const { systemPrompt, listingsData, paymentPlans, faqs } = clientData;

    // Inject placeholders dynamically
    const finalPrompt = systemPrompt
        .replace("{{listingsData}}", listingsData || "")
        .replace("{{paymentPlans}}", paymentPlans || "")
        .replace("{{faqs}}", faqs || "");

    return finalPrompt;
}
