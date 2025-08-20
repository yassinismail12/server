import mongoose from "mongoose";

const clientSchema = new mongoose.Schema({
    name: { type: String, required: true },         // client name
    email: { type: String },                        // optional email
    messagesUsed: { type: Number, default: 0 },     // how many messages they've used
    quota: { type: Number, default: 5000 },         // message quota
    createdAt: { type: Date, default: Date.now },   // when the client was added
});

// MongoDB will auto-generate `_id` for each client, so you don’t need to add it manually.
const Client = mongoose.model("Client", clientSchema);

export default Client;
