import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
const app = express();
dotenv.config();
// Use your connection string directly

const MONGO_URI = process.env.MONGO_URI;

// Connect to MongoDB

mongoose
    .connect(MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    })
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB connection error:", err));
// Your routes here
app.use("/api/chat", yourChatRoute);
app.use("/webhook", yourMessengerRoute);

app.listen(3000, () => {
    console.log("Server running on port 3000");
});