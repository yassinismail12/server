import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import chatRoute from "./web.js";
import messengerRoute from "./messenger.js";

const app = express();
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

// ✅ Define schema + model directly here
const clientSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String },
    messageCount: { type: Number, default: 0 },   // make sure this matches your Atlas field
    quota: { type: Number, default: 1000 },
    createdAt: { type: Date, default: Date.now },
});

// Force collection name "Clients"
const Client = mongoose.model("Client", clientSchema, "Clients");

// Root route
app.get("/", (req, res) => {
    res.send("✅ Server is running!");
});

// Dashboard stats route
app.get("/api/stats", async (req, res) => {
    try {
        const totalClients = await Client.countDocuments();
        const clients = await Client.find();

        const used = clients.reduce((sum, c) => sum + (c.messageCount || 0), 0);

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

        res.json({ totalClients, used, quota: 1000, weeklyData });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// API routes
app.use("/api/chat", chatRoute);
app.use("/webhook", messengerRoute);

// ✅ MongoDB connection + start server only after DB connects
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log("✅ MongoDB connected");
        app.listen(3000, () => {
            console.log("🚀 Server running on port 3000");
        });
    })
    .catch((err) => console.error("❌ MongoDB connection error:", err));
