import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI || "your-mongodb-uri-here";
const client = new MongoClient(uri);
const dbName = "Agent"; // your database name

let db;

// Connect to the MongoDB database (only once)
export async function connectToDB() {
    if (!db) {
        await client.connect();
        db = client.db(dbName);
        console.log("✅ Connected to MongoDB");
    }
    return db;
}

// Fetch a client from the 'Clients' collection using clientId
export async function getClientById(clientId) {
    const db = await connectToDB();
    const clientsCollection = db.collection("Clients");

    console.log("📦 Looking for clientId:", clientId);
    const client = await clientsCollection.findOne({ clientId });
    console.log("🔍 Found client:", client);

    return client;
}

// Fetch conversation history from 'Conversations' collection using clientId and userId
export async function getConversation(clientId, userId) {
    const db = await connectToDB();
    const conversations = db.collection("Conversations");

    console.log(`📦 Fetching conversation for clientId: ${clientId}, userId: ${userId}`);
    const convo = await conversations.findOne({ clientId, userId });
    console.log("🔍 Found conversation:", convo);

    return convo;
}

// Save or update conversation history in 'Conversations' collection
export async function saveConversation(clientId, userId, history) {
    const db = await connectToDB();
    const conversations = db.collection("Conversations");

    console.log(`💾 Saving conversation for clientId: ${clientId}, userId: ${userId}`);
    await conversations.updateOne(
        { clientId, userId },
        { $set: { history, updatedAt: new Date() } },
        { upsert: true }
    );
    console.log("✅ Conversation saved");
}
