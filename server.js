import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import chatRoute from "./web.js";          // 👈 Import your chat route
import messengerRoute from "./messenger.js";

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
app.use("/api/chat", chatRoute);
app.use("/webhook", messengerRoute);

app.listen(3000, () => {
    console.log("Server running on port 3000");
});