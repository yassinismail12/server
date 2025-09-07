// utils/messengerCredentials.js
import { MongoClient } from "mongodb";

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// Helper to normalize pageId (same as messenger.js)
function normalizePageId(id) {
    return id.toString().trim();
}

export async function getClientCredentials(pageId) {
    if (!mongoClient.topology?.isConnected()) {
        await mongoClient.connect();
    }

    const db = mongoClient.db(dbName);
    const pageIdStr = normalizePageId(pageId); // <-- use helper

    const clientDoc = await db.collection("Clients").findOne({ pageId: pageIdStr });

    if (!clientDoc) {
        throw new Error(`Client not found for pageId: ${pageIdStr}`);
    }

    const { PAGE_ACCESS_TOKEN, VERIFY_TOKEN } = clientDoc;

    if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN) {
        throw new Error(`Missing PAGE_ACCESS_TOKEN or VERIFY_TOKEN for pageId: ${pageIdStr}`);
    }

    return { PAGE_ACCESS_TOKEN, VERIFY_TOKEN };
}
