// services/products.js
import fs from "fs";
import OpenAI from "openai";
import { MongoClient } from "mongodb";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== DB CONNECTION =====
async function connectDB() {
    if (!mongoClient.topology?.isConnected()) {
        await mongoClient.connect();
    }
    return mongoClient.db(dbName);
}

// ===== PRODUCTS CRUD =====
export async function saveProduct(product) {
    const db = await connectDB();
    await db.collection("Products").updateOne(
        { id: product.id },
        { $set: product },
        { upsert: true }
    );
}

export async function getAllProducts() {
    const db = await connectDB();
    return db.collection("Products").find().toArray();
}

export async function updateProductEmbedding(id, embedding) {
    const db = await connectDB();
    await db.collection("Products").updateOne(
        { id },
        { $set: { embedding } }
    );
}

// ===== IMPORT PRODUCTS (RUN ONCE) =====
// Example: await importProducts("./products.json")
export async function importProducts(filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    const products = JSON.parse(raw);

    console.log(`⏳ Importing ${products.length} products...`);

    // 1. Save products
    for (const item of products) {
        await saveProduct({
            id: item.id,
            name: item.name,
            price: item.price,
            imageURL: item.imageURL,
            description: item.description || "",
            embedding: null,
        });
    }

    console.log("✔ Products saved. Now generating embeddings...");

    // 2. Create embeddings
    for (const item of products) {
        const embedding = await openai.embeddings.create({
            model: "text-embedding-3-large",
            input: item.imageURL,
        });

        await updateProductEmbedding(
            item.id,
            embedding.data[0].embedding
        );
    }

    console.log("🎉 Import completed!");
}

// ===== IMAGE MATCHING FUNCTION =====
export async function matchProduct(userImageUrl) {
    // 1. Create embedding for user image
    const embed = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: userImageUrl,
    });

    const userVec = embed.data[0].embedding;

    // 2. Load products
    const products = await getAllProducts();

    // 3. Similarity function
    function cosine(A, B) {
        let dot = 0, a = 0, b = 0;
        for (let i = 0; i < A.length; i++) {
            dot += A[i] * B[i];
            a += A[i] * A[i];
            b += B[i] * B[i];
        }
        return dot / (Math.sqrt(a) * Math.sqrt(b));
    }

    // 4. Find best match
    let best = null;
    let bestScore = -1;

    for (const p of products) {
        if (!p.embedding) continue;

        const score = cosine(userVec, p.embedding);
        if (score > bestScore) {
            bestScore = score;
            best = p;
        }
    }

    return {
        product: best,
        score: bestScore,
    };
}
