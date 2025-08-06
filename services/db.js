import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI || "your-mongodb-uri-here";
const client = new MongoClient(uri);
const dbName = "agents"; // or whatever your DB name is

let db;

export async function connectToDB() {
    if (!db) {
        await client.connect();
        db = client.db(dbName);
        console.log("✅ Connected to MongoDB");
    }
    return db;
}

export async function getClientByWidgetId(widgetId) {
    const db = await connectToDB();
    const clientsCollection = db.collection("clients");

    const client = await clientsCollection.findOne({ widgetId });
    return client;
}
