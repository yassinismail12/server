import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
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
}, { _id: false }); // don’t create a new _id for each message

const conversationSchema = new mongoose.Schema({
    userId: { type: String, required: true },      // links to the user
    clientId: { type: String, required: true },    // which client (realestate, etc.)
    history: [messageSchema],                      // array of messages
}, { timestamps: true }); // adds createdAt & updatedAt automatically

// ✅ Only ONE default export
const Conversation = mongoose.model("Conversation", conversationSchema, "Conversations");
export default Conversation;
