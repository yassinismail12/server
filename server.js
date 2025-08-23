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
        const used = clients.reduce((sum, c) => sum + (c.messageCount || 0), 0);

        // 🔹 Sum of all client quotas
        const quota = clients.reduce((sum, c) => sum + (c.messageLimit || 0), 0);

        // 🔹 Messages remaining = quota - used
        const remaining = quota - used;

        // 🔹 Weekly stats (dummy data for now until messages are stored separately)
        const weeklyData = [
            { day: "Mon", messages: 12 },
            { day: "Tue", messages: 22 },
            { day: "Wed", messages: 35 },
            { day: "Thu", messages: 10 },
            { day: "Fri", messages: 15 },
            { day: "Sat", messages: 18 },
            { day: "Sun", messages: 20 },
        ];

        // 🔹 Build clients array for dashboard table
        const clientsData = clients.map(c => {
            const used = c.messageCount || 0;
            const quota = c.messageLimit || 0;
            const remaining = quota - used;
            return {
                _id: c._id,
                name: c.name,
                email: c.email || "",
                used,
                quota,
                remaining,
                lastActive: c.updatedAt || c.createdAt
            };
        });

        res.json({
            totalClients,
            used,
            remaining,
            quota,
            weeklyData,
            clients: clientsData
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// ✅ Create new client
app.post("/api/clients", async (req, res) => {
    try {
        const { name, email, messageLimit } = req.body;
        const client = new Client({
            name,
            email,
            messageLimit: messageLimit || 100, // default quota
            messageCount: 0
        });
        await client.save();
        res.status(201).json(client);
    } catch (err) {
        console.error("❌ Error creating client:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ✅ Update existing client
app.put("/api/clients/:id", async (req, res) => {
    try {
        const { name, email, messageLimit } = req.body;
        const client = await Client.findByIdAndUpdate(
            req.params.id,
            { name, email, messageLimit },
            { new: true }
        );
        if (!client) return res.status(404).json({ error: "Client not found" });
        res.json(client);
    } catch (err) {
        console.error("❌ Error updating client:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ✅ Delete client
app.delete("/api/clients/:id", async (req, res) => {
    try {
        const client = await Client.findByIdAndDelete(req.params.id);
        if (!client) return res.status(404).json({ error: "Client not found" });
        res.json({ message: "✅ Client deleted" });
    } catch (err) {
        console.error("❌ Error deleting client:", err);
        res.status(500).json({ error: "Server error" });
    }
});
