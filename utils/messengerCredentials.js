import { MongoClient } from "mongodb";

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

async function getClientCredentials(pageId) {
    if (!mongoClient.topology?.isConnected()) {
        await mongoClient.connect();
    }

    const db = mongoClient.db(dbName);
    const clientDoc = await db.collection("Clients").findOne({ pageId });

    if (!clientDoc) {
        throw new Error(`Client not found for pageId: ${pageId}`);
    }

    const { PAGE_ACCESS_TOKEN, VERIFY_TOKEN } = clientDoc;

    if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN) {
        throw new Error(`Missing PAGE_ACCESS_TOKEN or VERIFY_TOKEN for pageId: ${pageId}`);
    }

    return { PAGE_ACCESS_TOKEN, VERIFY_TOKEN };
}
