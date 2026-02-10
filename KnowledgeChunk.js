import mongoose from "mongoose";

const KnowledgeChunkSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  botType: { type: String, default: "default", index: true },
  section: { type: String, required: true, index: true }, // menu / offers / hours / faqs / listings
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// 🔍 Text search for retrieval
KnowledgeChunkSchema.index(
  { text: "text" },
  {
    weights: { text: 10 },
    name: "KnowledgeTextIndex",
  }
);

// ⚡ Fast filtering by client / bot / section
KnowledgeChunkSchema.index({
  clientId: 1,
  botType: 1,
  section: 1,
});

export default mongoose.model("KnowledgeChunk", KnowledgeChunkSchema);
