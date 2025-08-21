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

mongoose.connect(MONGODB_URI)
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
        console.log("📊 Clients from DB:", clients);   // Debug entire array
        console.log("✅ Total clients:", totalClients);

        const used = clients.reduce((sum, c) => sum + (c.messageCount || 0), 0);
        console.log("💬 Total used messages:", used);


        // Sum of all client quotas (messageLimit)
        const quota = clients.reduce((sum, c) => sum + (c.messageLimit || 0), 0);
        console
        // Dummy weekly data (later: calculate real daily usage)
        const weeklyData = [
            { day: "Mon", messages: 12 },
            { day: "Tue", messages: 22 },
            { day: "Wed", messages: 35 },
            { day: "Thu", messages: 10 },
            { day: "Fri", messages: 15 },
            { day: "Sat", messages: 18 },
            { day: "Sun", messages: 20 },
        ];

        res.json({ totalClients, used, quota, weeklyData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
