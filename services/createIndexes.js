export async function ensureIndexes(db) {
  const chunks = db.collection("knowledge_chunks");

  // Text search on chunk content
  await chunks.createIndex({ text: "text" });

  // Fast filtering by client + bot + section
  await chunks.createIndex({ clientId: 1, botType: 1, section: 1 });

  console.log("✅ Mongo indexes ensured");
}
