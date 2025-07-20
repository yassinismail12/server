import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { setupIceBreakers } from "./services/messenger.js";
import webRoutes from "./web.js";
import messengerRoutes from "./messenger.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/chat", webRoutes);
app.use("/webhook", messengerRoutes);

// Test route
app.get("/", (req, res) => {
    res.send("✅ Real Estate Chatbot Backend is running");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
    setupIceBreakers(); // Run once at startup
});
