import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import chatRoute from "./web.js";
import messengerRoute from "./messenger.js";
import Client from "./Client.js";
const app = express();
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

// ✅ Define schema + model directly here

// Force collection name "Clients"


// Root route
app.get("/", (req, res) => {
    res.send("✅ Server is running!");
});

// Dashboard stats route

// API routes
app.use("/api/chat", chatRoute);
app.use("/webhook", messengerRoute);

// ✅ MongoDB connection + start server only after DB connects
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI, { dbName: "Agent" })

    .then(() => {
        console.log("✅ MongoDB connected:", mongoose.connection.name);
        console.log("📂 Collections:", Object.keys(mongoose.connection.collections));
        app.listen(3000, () => {
            console.log("🚀 Server running on port 3000");
        });
    })
    .catch((err) => console.error("❌ MongoDB connection error:", err));
app.get("/api/stats", async (req, res) => {
    try {
        const totalClients = await Client.countDocuments();
        const clients = await Client.find();

        console.log("✅ Total clients:", totalClients);

        // 🔹 Total messages used across all clients
        const used = clients.reduce((sum, c) => sum + (c.messagesUsed || 0), 0);

        // 🔹 Sum of all client quotas
        const quota = clients.reduce((sum, c) => sum + (c.messageLimit || 0), 0);

        // 🔹 Messages remaining = quota - used
        const remaining = quota - used;

        // 🔹 Dynamic weekly stats
        // assuming each Client has a `messages` array with { text, createdAt }
        const today = new Date();
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay()); // Sunday

        const weeklyCounts = {
            Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0
        };

        clients.forEach(c => {
            (c.messages || []).forEach(m => {
                const d = new Date(m.createdAt);
                if (d >= startOfWeek) {
                    const day = d.toLocaleDateString("en-US", { weekday: "short" });
                    if (weeklyCounts[day] !== undefined) {
                        weeklyCounts[day]++;
                    }
                }
            });
        });

        const weeklyData = Object.entries(weeklyCounts).map(([day, count]) => ({
            day,
            messages: count
        }));

        res.json({
            totalClients,
            used,
            remaining,
            quota,
            weeklyData
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
