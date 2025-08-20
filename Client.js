import mongoose from "mongoose";

const clientSchema = new mongoose.Schema({
    name: { type: String, required: true },          // client name
    email: { type: String },                         // optional email
    messageCount: { type: Number, default: 0 },      // how many messages they've used
    quota: { type: Number, default: 1000 },          // message quota
    createdAt: { type: Date, default: Date.now },    // when the client was added
});

// Force Mongoose to use the "Clients" collection
const Client = mongoose.model("Client", clientSchema, "Clients");

export default Client;
