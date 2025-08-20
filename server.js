import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import chatRoute from "./web.js";
import messengerRoute from "./messenger.js";
import Client from "./Client.js"; // ✅ Import your model

const app = express();
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

// Root route
app.get("/", (req, res) => {
    res.send("✅ Server is running!");
});

// Dashboard stats route
app.get("/api/stats", async (req, res) => {
    try {
        const totalClients = await Client.countDocuments();
        const clients = await Client.find();

        const used = clients.reduce((sum, c) => sum + (c.messagesUsed || 0), 0);

        // For now, still dummy weeklyData (later you can log per-day usage)
        const weeklyData = [
            { day: "Mon", messages: 12 },
            { day: "Tue", messages: 22 },
            { day: "Wed", messages: 35 },
            { day: "Thu", messages: 10 },
            { day: "Fri", messages: 15 },
            { day: "Sat", messages: 8 },
            { day: "Sun", messages: 20 },
        ];

        res.json({ totalClients, used, quota: 5000, weeklyData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
mongoose
    .connect(MONGODB_URI)
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB connection error:", err));

// API routes
app.use("/api/chat", chatRoute);
app.use("/webhook", messengerRoute);

// Start server
app.listen(3000, () => {
    console.log("🚀 Server running on port 3000");
});
