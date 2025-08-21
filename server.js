import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import chatRoute from "./web.js";
import messengerRoute from "./messenger.js";
import Client from "./Client.js";
import connectDB from "./services/db.js";   // <-- use db.js here

const app = express();
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

// Root route
app.get("/", (req, res) => {
    res.send("✅ Server is running!");
});

// API routes
app.use("/api/chat", chatRoute);
app.use("/webhook", messengerRoute);

// Dashboard stats route
app.get("/api/stats", async (req, res) => {
    try {
        const totalClients = await Client.countDocuments();
        const clients = await Client.find();

        console.log("📊 Clients from DB:", clients);   // Debug
        console.log("✅ Total clients:", totalClients);

        const used = clients.reduce((sum, c) => sum + (c.messageCount || 0), 0);
        console.log("💬 Total used messages:", used);

        const quota = clients.reduce((sum, c) => sum + (c.messageLimit || 0), 0);
        console.log("📈 Total client quotas:", quota);

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

// ✅ Start server only after DB connects
const PORT = 3000;
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});
