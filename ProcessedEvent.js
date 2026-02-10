import mongoose from "mongoose";

const ProcessedEventSchema = new mongoose.Schema(
  {
    pageId: { type: String, required: true },    // store as STRING always
    eventKey: { type: String, required: true },  // unique per event
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ✅ Unique only when both fields exist (prevents null/null collisions)
ProcessedEventSchema.index(
  { pageId: 1, eventKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      pageId: { $type: "string" },
      eventKey: { $type: "string" },
    },
  }
);

// ✅ Force collection name (so you don't get 2 collections again)
export default mongoose.model("ProcessedEvent", ProcessedEventSchema, "processed_events");
