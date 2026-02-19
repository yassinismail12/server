import mongoose from "mongoose";

const OrderSchema = new mongoose.Schema(
  {
   clientId: { type: String, required: true, index: true }
,

    channel: { type: String, enum: ["messenger", "instagram", "web"], required: true },

    customer: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" }, // optional, can be empty
      externalUserId: { type: String, default: "" }, // psid / ig user id / web session id
    },

    itemsText: { type: String, default: "" }, // quick MVP: store as text
    notes: { type: String, default: "" },

    status: { type: String, enum: ["new", "confirmed", "cancelled"], default: "new" },
  },
  { timestamps: true }
);

export default mongoose.model("Order", OrderSchema);
