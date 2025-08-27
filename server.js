import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import Conversation from "./conversations.js";  // ✅ Add this at the top with other imports
import multer from "multer";
import path from "path";
import fs from "fs";
import chatRoute from "./web.js";
import messengerRoute from "./messenger.js";
import Client from "./Client.js";

const app = express();
dotenv.config();

// Middleware
app.use(cors());
app.use(express.json());

// ✅ Ensure uploads folder exists
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// ✅ Multer config (safe file upload)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + "-" + file.originalname);
    }
});

// ✅ File filter: allow only safe types
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        "text/plain",          // .txt
        "text/markdown",       // .md
        "text/csv",            // .csv
        "text/tab-separated-values", // .tsv
        "application/pdf"      // .pdf
    ];

    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("❌ Invalid file type. Only TXT, MD, CSV, TSV, PDF allowed."), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5 MB max
});

// ✅ File upload route (basic)
app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "❌ No file uploaded" });
    }
    res.json({
        message: "✅ File uploaded successfully",
        filename: req.file.filename,
        path: `/uploads/${req.file.filename}`,
        size: req.file.size
    });
});


// ✅ Upload file & save into Client.files[]
app.post("/upload/:clientId", upload.single("file"), async (req, res) => {
    try {
        const { clientId } = req.params;
        const { name } = req.body;

        if (!req.file) {
            return res.status(400).json({ error: "❌ No file uploaded" });
        }

        // ✅ Read file content as string
        const filePath = path.join(uploadDir, req.file.filename);
        let content = "";

        if (req.file.mimetype === "application/pdf") {
            // optional: integrate pdf-parse later
            content = "[PDF uploaded: raw content extraction not implemented yet]";
        } else {
            content = fs.readFileSync(filePath, "utf8");
        }

        // ✅ Find client
        const client = await Client.findById(clientId);
        if (!client) {
            return res.status(404).json({ error: "❌ Client not found" });
        }

        // ✅ Add file entry into client's files[]
        client.files.push({
            name: name || req.file.originalname,
            content,
        });

        await client.save();

        res.json({
            message: "✅ File uploaded and saved to client",
            client,
        });
    } catch (err) {
        console.error("❌ Error saving file to client:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ✅ Remove a file from Client.files[] by its _id
app.delete("/clients/:clientId/files/:fileId", async (req, res) => {
    try {
        const { clientId, fileId } = req.params;

        const client = await Client.findById(clientId);
        if (!client) {
            return res.status(404).json({ error: "❌ Client not found" });
        }

        // remove matching file
        client.files = client.files.filter(f => f._id.toString() !== fileId);
        await client.save();

        res.json({ message: "✅ File removed", client });
    } catch (err) {
        console.error("❌ Error deleting file:", err);
        res.status(500).json({ error: "Server error" });
    }
});


// Serve uploaded files safely
app.use("/uploads", express.static(uploadDir));

// Root route
app.get("/", (req, res) => {
    res.send("✅ Server is running!");
});

// Dashboard stats route
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
                clientId: c.clientId || "",
                pageId: c.pageId || 0,
                quota,
                remaining,
                systemPrompt: c.systemPrompt || "",
                faqs: c.faqs || "",
                files: c.files || [],
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
        const clientData = req.body;

        const client = new Client({
            ...clientData,
            messageLimit: clientData.quota || 100, // ✅ map quota → messageLimit
            messageCount: clientData.messageCount || 0
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
        const clientData = { ...req.body };

        // ✅ Map quota → messageLimit if present
        if (clientData.quota !== undefined) {
            clientData.messageLimit = clientData.quota;
            delete clientData.quota;
        }

        const client = await Client.findByIdAndUpdate(
            req.params.id,
            clientData,
            { new: true, runValidators: true }
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


// ✅ Get all conversations (for dashboard)
app.get("/api/conversations", async (req, res) => {
    try {
        const conversations = await Conversation.find().sort({ updatedAt: -1 });
        res.json(conversations);
    } catch (err) {
        console.error("❌ Error fetching conversations:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ✅ Get a single conversation by ID
app.get("/api/conversations/:id", async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if (!conversation) return res.status(404).json({ error: "Conversation not found" });
        res.json(conversation);
    } catch (err) {
        console.error("❌ Error fetching conversation:", err);
        res.status(500).json({ error: "Server error" });
    }
});



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
