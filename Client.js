import mongoose from "mongoose";

const promptConfigSchema = new mongoose.Schema(
  {
    businessName: { type: String, default: "" },
    businessType: { type: String, default: "default" },
    tone: { type: String, default: "friendly" },
    matchUserLanguage: { type: Boolean, default: true },

    humanEscalation: {
      enabled: { type: Boolean, default: true },
      token: { type: String, default: "[Human_request]" },
    },

    orderFlow: {
      enabled: { type: Boolean, default: false },
      token: { type: String, default: "[ORDER_REQUEST]" },
      summaryTitle: { type: String, default: "Order Summary" },
      confirmationQuestion: { type: String, default: "Confirm order?" },
      cancelMessage: {
        type: String,
        default: "Okay, I cancelled the order request.",
      },
      confirmationMessage: {
        type: String,
        default:
          "Your order request has been received.\nA staff member will contact you shortly to confirm the details.",
      },
      storeLabel: { type: String, default: "Store" },
      nameLabel: { type: String, default: "Customer Name" },
      phoneLabel: { type: String, default: "Customer Phone" },
      itemsLabel: { type: String, default: "Items" },
      deliveryLabel: { type: String, default: "Delivery Info" },
      notesLabel: { type: String, default: "Notes" },
      requiredFields: {
        type: [String],
        default: [
          "customer_name",
          "customer_phone",
          "fulfillment_type",
          "address_if_delivery",
          "items",
        ],
      },
      optionalFields: {
        type: [String],
        default: ["notes"],
      },
    },
  },
  { _id: false }
);

const clientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String },
  active: { type: Boolean, default: true },
  faqs: { type: String },
  listingsData: { type: String },
  paymentPlans: { type: String },
  systemPrompt: { type: String }, // keep this for optional custom additions
  clientId: { type: String, required: true },
  igId: { type: String, default: "" },
  pageId: { type: String },
  messageCount: { type: Number, default: 0 },
  messageLimit: { type: Number, default: 1000 },
  quotaWarningSent: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  igAccessToken: { type: String, default: "" },
  PAGE_ACCESS_TOKEN: { type: String, default: "" },
  VERIFY_TOKEN: { type: String, default: "menus" },
  PAGE_NAME: { type: String, default: "" },

  staffWhatsApp: {
    type: String,
    default: "",
  },

  lastWebhookAt: { type: Date, default: null },
  lastWebhookType: { type: String, default: "" },
  lastWebhookPayload: { type: Object, default: null },

  staffNumbers: { type: [String], default: [] },

  whatsappPhoneNumberId: { type: String, default: "" },
  whatsappWabaId: { type: String, default: "" },
  whatsappAccessToken: { type: String, default: "" },
  whatsappDisplayPhone: { type: String, default: "" },
  whatsappConnectedAt: { type: Date, default: null },
  whatsappTokenExpiresAt: { type: Date, default: null },
  whatsappTokenType: { type: String, default: "user_long_lived" },

  igUsername: { type: String, default: "" },
  igName: { type: String, default: "" },
  igProfilePicUrl: { type: String, default: "" },

  whatsappVerifiedName: { type: String, default: "" },
  botBuilt: { type: Boolean, default: false },
  knowledgeStatus: { type: String, default: "empty" },
  knowledgeVersion: { type: Number, default: 0 },
  knowledgeBotType: { type: String, default: "default" },
  knowledgeBuiltAt: { type: Date, default: null },
  sectionsPresent: { type: [String], default: [] },
  coverageWarnings: { type: [String], default: [] },

  promptConfig: {
    type: promptConfigSchema,
    default: () => ({}),
  },

  files: [
    {
      name: { type: String, required: true },
      label: { type: String },
      content: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],
});

const Client = mongoose.model("Client", clientSchema, "Clients");

export default Client;