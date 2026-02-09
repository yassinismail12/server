import mongoose from "mongoose";

const DatasetSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  botType: { type: String, default: "default" },
  rawSections: { type: Object, default: {} },
  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Dataset", DatasetSchema);
