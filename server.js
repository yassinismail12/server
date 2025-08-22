import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";

import webRoutes from "./web.js";
import messengerRoutes from "./messenger.js";
import Client from "./models/Client.js"; // <-- make sure you have this schema

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Connect to MongoDB
mongoose.connect(MONGODB_URI, { dbName: "Agent" })

    .then(() => console.log("✅ MongoDB connected:", mongoose.connection.name))
    .catch((err) => console.error("❌ MongoDB error:", err));

// Existing routes
app.use("/api/chat", webRoutes);
app.use("/webhook", messengerRoutes);

/**
 * GET /api/stats
 * Returns dashboard stats (clients, usage, weekly data)
 */
app.get("/api/stats", async (req, res) => {
    try {
        const clients = await Client.find();

        const totalClients = clients.length;
        const used = clients.reduce((sum, c) => sum + (c.messagesUsed || 0), 0);
        const quota = 1000; // global quota (can make dynamic later)

        // Mock weekly data (replace with real aggregation if you track per-day messages)
        const weeklyData = [
            { day: "Mon", messages: Math.floor(Math.random() * 100) },
            { day: "Tue", messages: Math.floor(Math.random() * 100) },
            { day: "Wed", messages: Math.floor(Math.random() * 100) },
            { day: "Thu", messages: Math.floor(Math.random() * 100) },
            { day: "Fri", messages: Math.floor(Math.random() * 100) },
            { day: "Sat", messages: Math.floor(Math.random() * 100) },
            { day: "Sun", messages: Math.floor(Math.random() * 100) },
        ];

        // Format clients for frontend
        const formattedClients = clients.map((c) => ({
            _id: c._id,
            name: c.name,
            email: c.email || "—",
            used: c.messagesUsed || 0,
            quota: c.quota || 200, // default quota per client
            lastActive: c.updatedAt || null,
        }));

        res.json({
            totalClients,
            used,
            quota,
            weeklyData,
            clients: formattedClients,
        });
    } catch (err) {
        console.error("❌ Error in /api/stats:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
