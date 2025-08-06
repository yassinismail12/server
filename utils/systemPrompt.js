import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const dbName = "agent"; // change to your DB name

export async function SYSTEM_PROMPT(slug) {
    await client.connect();
    const db = client.db(dbName);
    const clients = db.collection("clients");

    const clientData = await clients.findOne({ slug });

    if (!clientData) throw new Error("Client not found");

    const { systemPrompt, listingsData, paymentPlans, faqs } = clientData;

    // Inject data into the systemPrompt where placeholders exist
    const finalPrompt = systemPrompt
        .replace("{{listings}}", listingsData || "")
        .replace("{{paymentPlans}}", paymentPlans || "")
        .replace("{{faqs}}", faqs || "");

    return finalPrompt;
}
