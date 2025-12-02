import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
  name: String,
  price: Number,
  image: String, // URL of the product image
  description: String,
});

export default mongoose.models.Product || mongoose.model("Product", productSchema);
