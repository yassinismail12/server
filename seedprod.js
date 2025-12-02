import mongoose from "mongoose";
import Product from "./Product.js";

await mongoose.connect(process.env.MONGO_URI);

await Product.create([
  {
    name: "Black Shoe",
    price: 450,
    image: "https://res.cloudinary.com/ddo9l8ij7/image/upload/v1764303309/user_uploads/l3mjs99vbhfaopangwsk.jpg"
  },
  {
    name: "Wooden Chair",
    price: 900,
    image: "https://res.cloudinary.com/ddo9l8ij7/image/upload/v1764214889/samples/chair.png"
  }
]);

console.log("Done!");
process.exit();
