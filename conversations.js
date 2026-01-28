import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["system", "user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },

    clientId: {
      type: String,
      required: true,
      index: true,
    },

    source: {
      type: String,
      enum: ["messenger", "web", "whatsapp","instagram"],
      default: "messenger",
      index: true,
    },

    history: [messageSchema],

    // 🔴 Human handoff state
    humanEscalation: {
      type: Boolean,
      default: false,
      index: true,
    },

    // 📊 Analytics counters (per conversation)
    humanRequestCount: {
      type: Number,
      default: 0,
    },

    tourRequestCount: {
      type: Number,
      default: 0,
    },
orderRequestCount: {
  type: Number,
  default: 0,
},
    lastInteraction: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true, // createdAt & updatedAt
  }
);

// 🔐 Prevent duplicate conversations per user/client/source
conversationSchema.index(
  { userId: 1, clientId: 1, source: 1 },
  { unique: true }
);

const Conversation = mongoose.model(
  "Conversation",
  conversationSchema,
  "Conversations"
);

export default Conversation;
