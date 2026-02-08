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
    igId: { type: String , default:""},            // Instagram ID
    pageId: { type: String },                      // page ID for Messenger
    messageCount: { type: Number, default: 0 },    // messages used
    messageLimit: { type: Number, default: 1000 }, // quota
    quotaWarningSent: { type: Boolean, default: false }, // ✅ add this field
    createdAt: { type: Date, default: Date.now },  // when the client was added
    igAccessToken: { type: String, default: "" },  // Instagram Page Access Token
    PAGE_ACCESS_TOKEN: { type: String, default: "" },
    VERIFY_TOKEN: { type: String, default: "" },
        PAGE_NAME: { type: String, default: "" },
staffWhatsApp: {
    type: String,
    default: "", // empty = no human handoff configured
},
lastWebhookAt: { type: Date, default: null },
lastWebhookType: { type: String, default: "" },
lastWebhookPayload: { type: Object, default: null },
// Client.js (mongoose)
staffNumbers: { type: [String], default: [] }, // E.164: "+2010..."

whatsappPhoneNumberId: { type: String, default: "" }, // metadata.phone_number_id
whatsappBusinessNumber: { type: String, default: "" }, // optional "+2011..."


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
