import mongoose from "mongoose";

const KnowledgeChunkSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  botType: { type: String, default: "default" },
  section: { type: String, required: true, index: true }, // menu/offers/hours/faqs/listings...
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

KnowledgeChunkSchema.index({ text: "text" });

export default mongoose.model("KnowledgeChunk", KnowledgeChunkSchema);
