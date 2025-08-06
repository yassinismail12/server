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

// Fetch a client from the 'clients' collection using clientId
export async function getClientById(clientId) {
    const db = await connectToDB();
    const clientsCollection = db.collection("Clients");

    console.log("📦 Looking for clientId:", clientId);
    const client = await clientsCollection.findOne({ clientId });
    console.log("🔍 Found client:", client);

    return client;
}
