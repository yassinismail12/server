import { MongoClient } from "mongodb";
import { ensureIndexes } from "./createIndexes.js"; // adjust path if needed

const uri = process.env.MONGODB_URI || "your-mongodb-uri-here";
const client = new MongoClient(uri);
const dbName = "Agent";

let db;

// Connect to the MongoDB database (only once)
export async function connectToDB() {
  if (!db) {
    await client.connect();
    db = client.db(dbName);
    console.log("✅ Connected to MongoDB");

    // ✅ add this (safe to run many times)
    await ensureIndexes(db);
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

// Find or create a customer
export async function findOrCreateCustomer(customerId, clientId) {
    const db = await connectToDB();
    const customers = db.collection("Customers");

    let customer = await customers.findOne({ customerId, clientId });

    if (!customer) {
        // Create new customer without name
        await customers.insertOne({
            customerId,
            clientId,
            name: null,
            lastInteraction: new Date()
        });
        console.log(`🆕 New customer created: ${customerId} for client: ${clientId}`);
        return null; // no name yet
    } else {
        // Update last interaction
        await customers.updateOne(
            { customerId, clientId },
            { $set: { lastInteraction: new Date() } }
        );
        return customer.name; // could be null if not set
    }
}

// Update a customer's name
export async function updateCustomerName(customerId, clientId, name) {
    const db = await connectToDB();
    const customers = db.collection("Customers");

    await customers.updateOne(
        { customerId, clientId },
        { $set: { name, lastInteraction: new Date() } }
    );
    console.log(`✏️ Updated name for ${customerId}: ${name}`);
}

/* ---------------- Name Detection Utilities ---------------- */

// Detect name from "my name is ..."
function extractNameFromUserMessage(message) {
    const match = message.match(/my name is\s+(.+)/i);
    return match ? match[1].trim() : null;
}

// Detect name from "[Name] ..."
function extractNameFromAI(aiMessage) {
    const match = aiMessage.match(/\[Name\]\s*(.+)/i);
    return match ? match[1].trim() : null;
}

// Check both triggers and save name if found
export async function detectAndSaveName(customerId, clientId, userMessage, aiMessage) {
    let detectedName = extractNameFromUserMessage(userMessage);

    if (!detectedName) {
        detectedName = extractNameFromAI(aiMessage);
    }

    if (detectedName) {
        await updateCustomerName(customerId, clientId, detectedName);
        console.log(`💾 Name detected and saved: ${detectedName}`);
    }
}
