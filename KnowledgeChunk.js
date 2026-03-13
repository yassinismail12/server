import mongoose from "mongoose";

const KnowledgeChunkSchema = new mongoose.Schema({
  clientId:        { type: String,   required: true, index: true },
  botType:         { type: String,   default: "default", index: true },
  section:         { type: String,   required: true, index: true },
  title:           { type: String,   default: "" },
  keywords:        { type: [String], default: [] },

  // ✅ NEW: Arabic keyword aliases for this chunk
  // These are used by scoreChunkAgainstQuery to match Arabic user queries
  // to English chunks. Populated automatically at save time by your
  // dataset processing route using the ARABIC_SECTION_KEYWORDS map below.
  arabicKeywords:  { type: [String], default: [] },

  text:            { type: String,   required: true },
  createdAt:       { type: Date,     default: Date.now },
});

// 🔍 Full-text search index (English)
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
  botType:  1,
  section:  1,
});

export default mongoose.model("KnowledgeChunk", KnowledgeChunkSchema);