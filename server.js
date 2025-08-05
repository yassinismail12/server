import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors"; // optional
import chatRoute from "./web.js";
import messengerRoute from "./messenger.js";

const app = express();
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

// Root route
app.get("/", (req, res) => {
    res.send("✅ Server is running!");
});

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI;
mongoose
    .connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB connection error:", err));

// API routes
app.use("/api/chat", chatRoute);
app.use("/webhook", messengerRoute);

// Start server
app.listen(3000, () => {
    console.log("🚀 Server running on port 3000");
});
