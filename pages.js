import mongoose from "mongoose";

const pageSchema = new mongoose.Schema({
  pageId: { type: String, required: true, unique: true },
  name: { type: String },
  userAccessToken: { type: String, required: true },
  pageAccessToken: { type: String }, // optional if you later exchange it
  clientId: { type: String }, // optional link if you want to associate with a client
  connectedAt: { type: Date, default: Date.now },
});

const Page = mongoose.model("Page", pageSchema);

export default Page;
