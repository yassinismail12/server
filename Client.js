import mongoose from "mongoose";

const clientSchema = new mongoose.Schema({
    name: { type: String, required: true },        // client name
    email: { type: String },                       // optional email
    active: { type: Boolean, default: true },      // active client
    faqs: { type: String },                        // FAQ markdown
    listingsData: { type: String },                // listings text/markdown
    paymentPlans: { type: String },                // payment plans markdown
    systemPrompt: { type: String },                // system prompt for the bot
    clientId: { type: String, required: true },    // client identifier
    pageId: { type: String },                      // page ID for Messenger
    messageCount: { type: Number, default: 0 },    // messages used
    messageLimit: { type: Number, default: 1000 }, // quota
    createdAt: { type: Date, default: Date.now },  // when the client was added

    PAGE_ACCESS_TOKEN: { type: String, default: "" },
    VERIFY_TOKEN: { type: String, default: "" },

    // ✅ Flexible file storage
    files: [
        {
            name: { type: String, required: true },   // user-defined name, e.g. "faq", "menu", "systemPrompt-v2"
            label: { type: String },                  // optional description/label (not required)
            content: { type: String, required: true }, // raw text inside the file
            createdAt: { type: Date, default: Date.now }
        }
    ]
});

// ✅ Force Mongoose to use the exact "Clients" collection
const Client = mongoose.model("Client", clientSchema, "Clients");

export default Client;



