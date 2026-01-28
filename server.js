import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "cors";
import Conversation from "./conversations.js";  // ✅ Add this at the top with other imports
import multer from "multer";
import path from "path";
import fs from "fs";
import chatRoute from "./web.js";
import messengerRoute from "./messenger.js";
import Client from "./Client.js";
import pdf from "pdf-parse/lib/pdf-parse.js";
import bcrypt from "bcrypt";
import instagramRoute from "./instagram.js";
import User from "./Users.js";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import Page from "./pages.js";
import Product from "./Product.js"; // ✅ this registers the model

const app = express();
dotenv.config();
const router = express.Router();
// Middleware
app.use(cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5500","https://dashboardai1.netlify.app","https://dashboardai1.netlify.app/client","https://dashboardai1.netlify.app/admin"],
    credentials: true
}));

app.use(cookieParser());

app.use(express.json({ limit: "10mb" })); // allow JSON up to 10 MB
app.use(express.urlencoded({ limit: "10mb", extended: true })); // for form data


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
        "application/pdf"  ,
          "application/json"     // .pdf
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
// ✅ Helper: Clean and normalize file content
function cleanFileContent(content, mimetype) {
    // Basic cleanup
    let cleaned = content
        .replace(/\r\n/g, "\n")      // normalize line breaks
        .replace(/[^\x20-\x7E\n]/g, "") // remove weird chars
        .replace(/\n{3,}/g, "\n\n") // collapse too many blank lines
        .trim();

    // CSV / TSV => turn into table-like text
    if (mimetype === "text/csv" || mimetype === "text/tab-separated-values") {
        const rows = cleaned.split("\n").map(r => r.split(/,|\t/).join(" | "));
        cleaned = rows.join("\n");
    }
    
    if (mimetype === "application/json") {
        try {
            const parsed = JSON.parse(content);
            cleaned = JSON.stringify(parsed, null, 2); // pretty print JSON
        } catch (err) {
            // leave as-is or handle error
        }
    }

    // Markdown: keep it, maybe just trim
    if (mimetype === "text/markdown") {
        cleaned = cleaned.trim();
    }

    return cleaned;
}
function requireClientOwnership(req, res, next) {
    if (req.user.role === "admin") return next(); // admins can update any client

    // For clients, enforce ownership
    if (req.user.role === "client") {
        const paramId = req.params.clientId || req.params.id; // use either
        if (paramId !== req.user.clientId) {
            return res.status(403).json({ error: "Forbidden" });
        }
    }

    next();
}
// Get a single client by clientId (for frontend)
app.get("/api/clients/:id", verifyToken, requireClientOwnership, async (req, res) => {
    try {
        const { id } = req.params;
        const client = await Client.findOne({ clientId: id });

        if (!client) {
            return res.status(404).json({ error: "Client not found" });
        }

        // 🔹 Aggregate conversation stats for this client
        const stats = await Conversation.aggregate([
            { $match: { clientId: id } },
            {
                $group: {
                    _id: "$clientId",
                    totalHumanRequests: { $sum: "$humanRequestCount" },
                    totalTourRequests: { $sum: "$tourRequestCount" },
                    totalorderRequests: { $sum: "$orderRequestCount" },
                    activeHumanChats: { $sum: { $cond: ["$humanEscalation", 1, 0] } },
                },
            },
        ]);

        const convoStats = stats[0] || {};

        res.json({
            _id: client._id,
            name: client.name,
            email: client.email || "",
            clientId: client.clientId || "",
            pageId: client.pageId || "",
            igId: client.igId || "",
            used: client.messageCount || 0,
            quota: client.messageLimit || 0,
            remaining: (client.messageLimit || 0) - (client.messageCount || 0),
            files: client.files || [],
            lastActive: client.updatedAt || client.createdAt,
            systemPrompt: client.systemPrompt || "",
            faqs: client.faqs || "",
            active: client.active ?? false,
            PAGE_ACCESS_TOKEN: client.PAGE_ACCESS_TOKEN || "",
            igAccessToken: client.igAccessToken || "",
PAGE_NAME: client.PAGE_NAME || "",
            // ✅ Added stats
            totalHumanRequests: convoStats.totalHumanRequests || 0,
            totalTourRequests: convoStats.totalTourRequests || 0,
            totalorderRequests: convoStats.totalorderRequests || 0,
            activeHumanChats: convoStats.activeHumanChats || 0,
        });
    } catch (err) {
        console.error("❌ Error fetching client:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// POST /admin/renew/:clientId

app.post("/admin/renew/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ error: "❌ Client not found" });
    }

    const now = new Date();
    const nextMonth = new Date();
    nextMonth.setMonth(now.getMonth() + 1);

    await Client.updateOne(
      { clientId },
      {
        $set: {
          messageCount: 0,           // ✔ correct field
          quotaWarningSent: false,
          currentPeriodStart: now,
          currentPeriodEnd: nextMonth,
        },
      }
    );

    res.json({ success: true, message: "Client renewed successfully" });

  } catch (err) {
    console.error("❌ Renew error:", err);
    res.status(500).json({ error: "Server error during renew" });
  }
});

// POST /admin/renew-all

app.post("/admin/renew-all", async (req, res) => {
  try {
    const now = new Date();
    const nextMonth = new Date();
    nextMonth.setMonth(now.getMonth() + 1);

    await Client.updateMany(
      {}, 
      {
        $set: {
          messageCount: 0,          // ✔ correct field
          quotaWarningSent: false,  // ✔ correct field
          currentPeriodStart: now,
          currentPeriodEnd: nextMonth,
        },
      }
    );

    res.json({ success: true, message: "All clients renewed successfully" });

  } catch (err) {
    console.error("❌ Renew-all error:", err);
    res.status(500).json({ error: "Server error during renew-all" });
  }
});



app.post("/api/create-admin", async (req, res) => {
    try {
        const { email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);

        const admin = new User({
            email,
            password: hashedPassword,
            role: "admin"
        });

        await admin.save();
        res.json({ message: "✅ Admin created", admin });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "❌ Error creating admin" });
    }
});
app.post("/api/create-client", async (req, res) => {
    try {
        const { name, email, password, clientId } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);

        const clientUser = new User({
            name,
            email,
            password: hashedPassword,
            role: "client",
            clientId
        });

        await clientUser.save();
        res.json({ message: "✅ Client user created", clientUser });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "❌ Error creating client user" });
    }
});
async function createAdmin() {
    const existing = await User.findOne({ role: "admin" });
    if (existing) return console.log("Admin already exists");

    const admin = new User({
        name: "YASSO",
        email: "yassin.ismail2005@gmail.com",
        password: await bcrypt.hash("admin123", 10), // choose secure password
        role: "admin",
        clientId: null // admins don’t need a clientId
    });

    await admin.save();
    console.log("✅ Admin created:", admin);
}

createAdmin();
app.post("/api/migrate-clients-to-users", async (req, res) => {
    try {
        const clients = await Client.find();

        const createdUsers = [];
        for (const c of clients) {
            // check if user already exists for this client
            const existing = await User.findOne({ clientId: c._id });
            if (existing) continue;

            const user = new User({
                name: c.name,
                email: c.email || `${c._id}@example.com`, // fallback if no email
                password: await bcrypt.hash("default123", 10), // set default password
                role: "client",
                clientId: c.clientId || ""
            });

            await user.save();
            createdUsers.push(user);
        }

        res.json({
            message: `✅ Migrated ${createdUsers.length} clients to users`,
            createdUsers
        });
    } catch (err) {
        console.error("❌ Migration error:", err);
        res.status(500).json({ error: "Migration failed" });
    }
});


// ✅ Upload file & save into Client.files[]
app.post("/upload/:clientId", verifyToken, requireClientOwnership, upload.single("file"), async (req, res) => {
    try {
        const { clientId } = req.params;
        const { name } = req.body;

        if (!req.file) {
            return res.status(400).json({ error: "❌ No file uploaded" });
        }

        const filePath = path.join(uploadDir, req.file.filename);
        let content = "";

        if (req.file.mimetype === "application/pdf") {
            const rawPdf = fs.readFileSync(filePath);
            const pdfData = await pdf(rawPdf);
            content = cleanFileContent(pdfData.text, req.file.mimetype);
        } else {
            const raw = fs.readFileSync(filePath, "utf8");
            content = cleanFileContent(raw, req.file.mimetype);
        }

        const client = await Client.findOne({ clientId });
        if (!client) {
            return res.status(404).json({ error: "❌ Client not found" });
        }

        client.files.push({
            name: name || req.file.originalname,
            content,
        });

        await client.save();

        res.json({
            message: "✅ File uploaded, cleaned, and saved to client",
            client,
        });
    } catch (err) {
        console.error("❌ Error saving file to client:", err);
        res.status(500).json({ error: "Server error" });
    }
});


export function verifyToken(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { id, role }
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
}



// ✅ Remove a file from Client.files[] by its _id
app.delete("/clients/:clientId/files/:fileId", verifyToken, requireClientOwnership, async (req, res) => {
    try {
        const { clientId, fileId } = req.params;

        const client = await Client.findOne({ clientId });
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
app.get("/api/stats", verifyToken, async (req, res) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
    }
    try {
        const totalClients = await Client.countDocuments();
        const clients = await Client.find();
// 🔹 Aggregate human + tour requests across ALL conversations
const convoStats = await Conversation.aggregate([
  {
    $group: {
      _id: null,
      totalHumanRequests: { $sum: "$humanRequestCount" },
      totalTourRequests: { $sum: "$tourRequestCount" },
      totalorderRequests: { $sum: "$orderRequestCount" },
      activeHumanChats: {
        $sum: { $cond: ["$humanEscalation", 1, 0] }
      }
    }
  }
]);

const globalStats = convoStats[0] || {
  totalHumanRequests: 0,
  totalTourRequests: 0,
    totalorderRequests: 0,
  activeHumanChats: 0
};

        console.log("✅ Total clients:", totalClients);

        // 🔹 Total messages used across all clients
        const used = clients.reduce((sum, c) => sum + (c.messageCount || 0), 0);

        // 🔹 Sum of all client quotas
        const quota = clients.reduce((sum, c) => sum + (c.messageLimit || 0), 0);

        // 🔹 Messages remaining = quota - used
        const remaining = quota - used;

        // 🔹 Weekly stats (dummy data for now until messages are stored separately)
        // 🔹 Chart mode
        const { mode } = req.query; // "daily", "weekly", "monthly"
        let pipeline = [];

        if (mode === "daily") {
            pipeline = [
                { $unwind: "$history" },
                {
                    $match: {
                        "history.role": "user",
                        "history.createdAt": {
                            $gte: new Date(new Date().setHours(0, 0, 0, 0)) // start of today
                        }
                    }
                },
                {
                    $group: {
                        _id: { $hour: "$history.createdAt" }, // group by hour
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } } // keep hours in order
            ];
        } else if (mode === "weekly") {
            pipeline = [
                { $unwind: "$history" },
                {
                    $match: {
                        "history.role": "user",
                        "history.createdAt": {
                            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // last 7 days
                        }
                    }
                },
                {
                    $group: {
                        _id: { $dayOfWeek: "$history.createdAt" }, // 1=Sun … 7=Sat
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } } // keep days in order
            ];
        } else if (mode === "monthly") {
            pipeline = [
                { $unwind: "$history" },
                {
                    $match: {
                        "history.role": "user",
                        "history.createdAt": {
                            $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // last 30 days
                        }
                    }
                },
                {
                    $group: {
                        _id: { $dayOfMonth: "$history.createdAt" }, // 1 … 31
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } } // keep days in order
            ];
        }

        const chartResults = pipeline.length > 0 ? await Conversation.aggregate(pipeline) : [];
const perClientStatsArr = await Conversation.aggregate([
    {
        $group: {
            _id: "$clientId",
            humanRequests: { $sum: "$humanRequestCount" },
            tourRequests: { $sum: "$tourRequestCount" },
            orderRequests: { $sum: "$orderRequestCount" }
        }
    }
]);

// 🔹 Build stats map
const statsMap = {};
perClientStatsArr.forEach(s => {
    statsMap[s._id] = {
        humanRequests: s.humanRequests || 0,
        tourRequests: s.tourRequests || 0,
        orderRequests: s.orderRequests || 0
    };
});
        // 🔹 Build clients array for dashboard table
       const clientsData = clients.map(c => {
    const used = c.messageCount || 0;
    const quota = c.messageLimit || 0;
    const remaining = quota - used;

    const clientStats = statsMap[c.clientId] || {}; // 🔹 get per-client counts

    return {
        _id: c._id,
        name: c.name,
        email: c.email || "",
        used,
        clientId: c.clientId || "",
        pageId: c.pageId || 0,
        igId: c.igId || "",
        quota,
        remaining,
        systemPrompt: c.systemPrompt || "",
        faqs: c.faqs || "",
        files: c.files || [],
        humanRequests: clientStats.humanRequests || 0,
        tourRequests: clientStats.tourRequests || 0,
        orderRequests: clientStats.orderRequests || 0,
        lastActive: c.updatedAt || c.createdAt,
        active: c.active ?? false,
        PAGE_ACCESS_TOKEN: c.PAGE_ACCESS_TOKEN || "",
        PAGE_NAME: c.PAGE_NAME || "",
        VERIFY_TOKEN: c.VERIFY_TOKEN || "",
        igAccessToken: c.igAccessToken || ""
    };
});

        res.json({
            totalClients,
            used,
            remaining,
            quota,
            chartResults,
              totalHumanRequests: globalStats.totalHumanRequests,
  totalTourRequests: globalStats.totalTourRequests,
    totalorderRequests: globalStats.totalorderRequests,
  activeHumanChats: globalStats.activeHumanChats,
            clients: clientsData
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
app.get("/api/stats/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
    try {
        const { clientId } = req.params;

        const client = await Client.findOne({ clientId });
        if (!client) {
            return res.status(404).json({ error: "❌ Client not found" });
        }

        // 🔹 Messages usage
        const used = client.messageCount || 0;
        const quota = client.messageLimit || 0;
        const remaining = quota - used;

        // 🔹 Chart data: last 30 days user messages
        // chart results for this client
        const { mode } = req.query; // "daily", "weekly", "monthly"


        // 🔹 Build aggregation pipeline based on mode
        let pipeline = [
            { $match: { clientId } },
            { $unwind: "$history" },
            { $match: { "history.role": "user" } }
        ];

        const now = new Date();

        if (mode === "daily") {
            pipeline.push({
                $match: {
                    "history.createdAt": { $gte: new Date(now.setHours(0, 0, 0, 0)) } // today
                }
            });
            pipeline.push({
                $group: {
                    _id: { $hour: "$history.createdAt" },
                    count: { $sum: 1 }
                }
            });
        } else if (mode === "weekly") {
            pipeline.push({
                $match: {
                    "history.createdAt": { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // last 7 days
                }
            });
            pipeline.push({
                $group: {
                    _id: { $dayOfWeek: "$history.createdAt" }, // 1=Sun … 7=Sat
                    count: { $sum: 1 }
                }
            });
        } else if (mode === "monthly") {
            pipeline.push({
                $match: {
                    "history.createdAt": { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // last 30 days
                }
            });
            pipeline.push({
                $group: {
                    _id: { $dayOfMonth: "$history.createdAt" }, // 1 … 31
                    count: { $sum: 1 }
                }
            });
        }

        pipeline.push({ $sort: { "_id": 1 } });

        const chartResults = await Conversation.aggregate(pipeline);
// Fetch all conversations for this client
const clientConvos = await Conversation.find({ clientId });

// Now you can safely calculate
const totalHumanRequests = clientConvos.reduce(
  (sum, c) => sum + (c.humanRequestCount || 0),
  0
);

const totalTourRequests = clientConvos.reduce(
  (sum, c) => sum + (c.tourRequestCount || 0),
  0
);
const orderRequestCount = clientConvos.reduce(
    (sum, c) => sum + (c.orderRequestCount || 0),
    0
);

const activeHumanChats = clientConvos.reduce(
  (sum, c) => sum + (c.humanEscalation ? 1 : 0),
  0
);


        // build the same shaped object as admin uses
        res.json({
            clientId: client._id,
            _id: client._id,
            name: client.name,
            email: client.email || "",
            clientId: client.clientId || "",
            pageId: client.pageId || "",
            used,
            igId: client.igId || "",
            quota,
            remaining,
            files: client.files || [],
            lastActive: client.updatedAt,
            systemPrompt: client.systemPrompt || "",
            faqs: client.faqs || "",
            lastActive: client.updatedAt || client.createdAt,
            active: client.active ?? false,
            PAGE_ACCESS_TOKEN: client.PAGE_ACCESS_TOKEN || "",
            PAGE_NAME: client.PAGE_NAME || "",
            igAccessToken: client.igAccessToken || "",
            chartResults,
             totalHumanRequests,
    totalTourRequests,
    totalorderRequests: orderRequestCount,
    activeHumanChats
        });
    } catch (err) {
        console.error("❌ Error fetching client stats:", err);
        res.status(500).json({ error: "Server error" });
    }
});



// ✅ Create new client (admin only)
app.post("/api/clients", verifyToken, async (req, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    try {
        const clientData = req.body;

        // 1. Create client
        const client = new Client({
            ...clientData,
            messageLimit: clientData.quota || 100, // ✅ map quota → messageLimit
            messageCount: clientData.messageCount || 0,
        });
        await client.save();

        // 2. Create linked user
        // make sure password comes from clientData
        const plainPassword = clientData.password || "default123"; // fallback if no password provided
        const hashedPassword = await bcrypt.hash(plainPassword, 10);

        const user = new User({
            name: clientData.name,
            email: clientData.email,
            password: hashedPassword,
            role: "client",
            clientId: client.clientId || ""
        });
        await user.save();

        // 3. Respond with both
        res.status(201).json({ client, user });
    } catch (err) {
        console.error("❌ Error creating client & user:", err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post("/api/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Check if user already exists
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ error: "Email already registered" });

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user as a client
        const user = new User({
            name,
            email,
            password: hashedPassword,
            role: "client",
            clientId: new mongoose.Types.ObjectId().toString() // unique clientId
        });
        await user.save();

        // Also create corresponding Client doc
        const client = new Client({
            name,
            email,
            clientId: user.clientId,
            messageLimit: 100,
            messageCount: 0,
            files: []
        });
        await client.save();
const token = jwt.sign(
  { id: user._id, role: user.role, clientId: user.clientId },
  process.env.JWT_SECRET,
  { expiresIn: "1h" }
);

res.cookie("token", token, {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 1000 * 60 * 60,
});

        res.status(201).json({ message: "✅ Registered successfully", user });
    } catch (err) {
        console.error("❌ Register error:", err);
        res.status(500).json({ error: "Server error" });
    }
});



app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: "Invalid password" });

        // ✅ Generate token
        const token = jwt.sign(
            { id: user._id, role: user.role, clientId: user.clientId },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        // ✅ Send it as an HttpOnly cookie
        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production", // set true in production
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
            maxAge: 1000 * 60 * 60,
        });


        res.json({ role: user.role }); // only return role
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});


app.get("/api/me", verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select("-password"); // exclude password

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json({
            id: user._id,
            email: user.email,
            role: user.role,
            clientId: user.clientId || null, // ✅ just return the string
            name: user.name,
        });
    } catch (err) {
        console.error("❌ /api/me error:", err);
        res.status(500).json({ error: "Server error" });
    }
});



app.post("/api/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  });
  res.json({ message: "Logged out" });
});





// ✅ Update existing client (admin or owner)
app.put("/api/clients/:id", verifyToken, requireClientOwnership, async (req, res) => {
    try {
        const clientData = { ...req.body };

        // ✅ Map quota → messageLimit if present
        if (clientData.quota !== undefined) {
            clientData.messageLimit = clientData.quota;
            delete clientData.quota;
        }

        const client = await Client.findOneAndUpdate(
            { clientId: req.params.id },
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

// ✅ Delete client (admin only)
app.delete("/api/clients/:id", verifyToken, async (req, res) => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    try {
        // delete client
        const client = await Client.findOneAndDelete({ clientId: req.params.id });

        if (!client) return res.status(404).json({ error: "Client not found" });

        // delete user linked to this client
        await User.findOneAndDelete({ clientId: req.params.id });

        res.json({ message: "✅ Client and linked user deleted" });
    } catch (err) {
        console.error("❌ Error deleting client & user:", err);
        res.status(500).json({ error: "Server error" });
    }
});


// ✅ Get all conversations (admin only)
app.get("/api/conversations", verifyToken, async (req, res) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
    }
    try {
        const { source } = req.query; // optional filter
        const query = source ? { source } : {};

        let conversations = await Conversation.find(query).sort({ updatedAt: -1 }).lean();

        // Remove system messages before sending
        conversations = conversations.map(convo => ({
            ...convo,
            history: convo.history.filter(msg => msg.role !== "system")
        }));

        res.json(conversations);
    } catch (err) {
        console.error("❌ Error fetching conversations:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// ✅ Get a single client's conversations
app.get("/api/conversations/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
    try {
        const clientId = req.params.clientId;
        const { source } = req.query; // optional filter
        const query = source ? { clientId, source } : { clientId };

        const conversations = await Conversation.find(query).lean();

        conversations.forEach(c => {
            c.history = c.history.filter(msg => msg.role !== "system");
        });

        res.json(conversations);
    } catch (err) {
        console.error("❌ Error fetching client conversations:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    // Check DB
    const db = await connectDB();
    await db.command({ ping: 1 });

    res.json({ status: "ok", time: new Date().toISOString() });
  } catch (err) {
    console.error("❌ Health check failed:", err.message);
    res.status(500).json({ status: "error", error: err.message });
  }
});
// --------------------
// 🌐 FACEBOOK OAUTH FLOW
// --------------------

// Step 1: Start OAuth flow
// STEP 1️⃣ — Start Facebook OAuth (backend redirects to Meta)
// Helpers
function normalizeUrl(u = "") {
  return String(u).trim().replace(/\/+$/, ""); // remove trailing slash
}

// ------------------------------
// OAuth START
// ------------------------------
app.get("/auth/facebook", async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).send("Missing clientId");

    const redirectUri = normalizeUrl(process.env.FACEBOOK_REDIRECT_URI);
    if (!redirectUri) return res.status(500).send("Missing FACEBOOK_REDIRECT_URI");

    const fbAuthUrl =
      `https://www.facebook.com/v20.0/dialog/oauth` +
      `?client_id=${encodeURIComponent(process.env.FACEBOOK_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(
        "pages_show_list,pages_read_engagement,pages_manage_metadata,pages_messaging"
      )}` +
      `&state=${encodeURIComponent(clientId)}`;

    console.log("🔁 OAuth START redirect_uri:", redirectUri);
    return res.redirect(fbAuthUrl);
  } catch (err) {
    console.error("❌ Error starting Facebook OAuth:", err);
    return res.status(500).send("OAuth start error");
  }
});

// ------------------------------
// Helper: store connection + webhook meta
// ------------------------------
async function upsertClientConnection({
  clientId,
  pageId,
  pageName,
  PAGE_ACCESS_TOKEN,
  userAccessToken,
  webhookSubscribed,
  webhookFields,
}) {
  await Client.updateOne(
    { clientId },
    {
      $set: {
        pageId,
        PAGE_NAME: pageName,
        PAGE_ACCESS_TOKEN,
        userAccessToken,
        connectedAt: new Date(),
        webhookSubscribed: Boolean(webhookSubscribed),
        webhookFields: webhookFields || [],
        webhookSubscribedAt: webhookSubscribed ? new Date() : null,
      },
    },
    { upsert: true }
  );
}

// ------------------------------
// OAuth CALLBACK
// ------------------------------
app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state } = req.query;
  const clientId = state;

  if (!code || !clientId) return res.status(400).send("Missing OAuth code or clientId");

  const redirectUri = normalizeUrl(process.env.FACEBOOK_REDIRECT_URI);
  const FRONTEND_URL = normalizeUrl(process.env.FRONTEND_URL || "http://localhost:5173");
  if (!redirectUri) return res.status(500).send("Missing FACEBOOK_REDIRECT_URI");

  try {
    console.log("🔁 OAuth CALLBACK redirect_uri:", redirectUri);
    console.log("🔁 OAuth CALLBACK params:", {
      hasCode: Boolean(code),
      clientId,
    });

    // 1) Exchange code -> user access token
    const tokenUrl =
      `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(process.env.FACEBOOK_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_secret=${encodeURIComponent(process.env.FACEBOOK_APP_SECRET)}` +
      `&code=${encodeURIComponent(code)}`;

    console.log("🧾 Token exchange URL (no secret):", {
      client_id: process.env.FACEBOOK_APP_ID,
      redirectUri,
      graph: "v20.0/oauth/access_token",
    });

    const tokenRes = await fetch(tokenUrl);
    const tokenText = await tokenRes.text();
    console.log("🧾 Token exchange HTTP:", tokenRes.status);
    console.log("🧾 Token exchange RAW:", tokenText);

    let tokenData = {};
    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      tokenData = { raw: tokenText };
    }

    if (!tokenData.access_token) {
      console.error("❌ Failed to get user access token:", tokenData);
      return res.status(400).send("Failed to get user access token");
    }

    const userAccessToken = tokenData.access_token;
    console.log("✅ Got user access token:", {
      preview: String(userAccessToken).slice(0, 15) + "...",
      expires_in: tokenData.expires_in,
      token_type: tokenData.token_type,
    });

    // 2) Get user's managed Pages
    const pagesUrl =
      `https://graph.facebook.com/v20.0/me/accounts` +
      `?fields=id,name,access_token` +
      `&access_token=${encodeURIComponent(userAccessToken)}`;

    console.log("📄 Fetch pages URL:", "v20.0/me/accounts?fields=id,name,access_token");

    const pagesRes = await fetch(pagesUrl);
    const pagesText = await pagesRes.text();
    console.log("📄 Fetch pages HTTP:", pagesRes.status);
    console.log("📄 Fetch pages RAW:", pagesText);

    let pagesData = {};
    try {
      pagesData = JSON.parse(pagesText);
    } catch {
      pagesData = { raw: pagesText };
    }

    if (!pagesData.data || pagesData.data.length === 0) {
      console.error("❌ No managed pages found:", pagesData);
      return res.status(400).send("No managed pages found");
    }

    console.log("✅ Pages found:", pagesData.data.map((p) => ({ id: p.id, name: p.name })));

    // ✅ Multiple pages: just store userAccessToken and redirect to picker
    if (pagesData.data.length > 1) {
      console.log("ℹ️ Multiple pages detected, redirecting to picker:", {
        count: pagesData.data.length,
      });

      await Client.updateOne(
        { clientId },
        { $set: { userAccessToken, connectedAt: new Date() } },
        { upsert: true }
      );

      return res.redirect(
        `${FRONTEND_URL}/client?choose_page=1&connected=partial&clientId=${encodeURIComponent(clientId)}`
      );
    }

    // Single Page path
    const page = pagesData.data[0];
    const pageId = page.id;
    const PAGE_ACCESS_TOKEN = page.access_token;
    const pageName = page.name;

    console.log("✅ Single page selected:", { pageId, pageName });

    if (!pageId || !PAGE_ACCESS_TOKEN) {
      console.error("❌ Invalid Page data:", page);
      return res.status(400).send("Invalid Page data");
    }

    // 3) Subscribe Page to Webhooks (include feed for comment demo)
    const fields = ["messages", "messaging_postbacks", "messaging_optins", "feed"];
    let webhookSubscribed = false;

    try {
      console.log("🧩 SUBSCRIBE (OAuth) Attempt", {
        pageId,
        pageName,
        fields,
        tokenPreview: String(PAGE_ACCESS_TOKEN || "").slice(0, 15) + "...",
      });

      const params = new URLSearchParams();
      params.append("subscribed_fields", fields.join(","));
      params.append("access_token", PAGE_ACCESS_TOKEN);

      const subUrl = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`;
      console.log("🧩 SUBSCRIBE URL:", subUrl);

      const subRes = await fetch(subUrl, { method: "POST", body: params });
      const subText = await subRes.text();

      console.log("🧩 SUBSCRIBE HTTP:", subRes.status);
      console.log("🧩 SUBSCRIBE RAW:", subText);

      let subData = {};
      try {
        subData = JSON.parse(subText);
      } catch {
        subData = { raw: subText };
      }

      console.log("✅ Webhook subscribe response (OAuth):", subData);

      webhookSubscribed = Boolean(subData?.success);
      if (!webhookSubscribed) console.warn("⚠️ Webhook subscription not confirmed (OAuth):", subData);
    } catch (err) {
      console.error("❌ Webhook subscription failed (OAuth):", err);
    }

    // 4) Store everything
    console.log("💾 upsertClientConnection:", {
      clientId,
      pageId,
      pageName,
      webhookSubscribed,
      fields,
    });

    await upsertClientConnection({
      clientId,
      pageId,
      pageName,
      PAGE_ACCESS_TOKEN,
      userAccessToken,
      webhookSubscribed,
      webhookFields: fields,
    });

    // 5) Redirect back
    console.log("↩️ Redirecting back to dashboard:", {
      url: `${FRONTEND_URL}/client?connected=success&pageId=${pageId}&pageName=${pageName}`,
    });

    return res.redirect(
      `${FRONTEND_URL}/client?connected=success&pageId=${encodeURIComponent(pageId)}&pageName=${encodeURIComponent(pageName)}`
    );
  } catch (err) {
    console.error("❌ OAuth callback error:", err);
    return res.status(500).send("OAuth callback error");
  }
});

// ------------------------------
// Visible "Enable Webhooks" action (for screencast proof)
// ------------------------------
app.post("/api/webhooks/subscribe/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    console.log("🟦 /api/webhooks/subscribe called:", { clientId });

    const client = await Client.findOne({ clientId }).lean();
    console.log("🟦 Client lookup result:", {
      found: Boolean(client),
      pageId: client?.pageId,
      hasPageToken: Boolean(client?.PAGE_ACCESS_TOKEN),
      tokenPreview: client?.PAGE_ACCESS_TOKEN ? String(client.PAGE_ACCESS_TOKEN).slice(0, 15) + "..." : null,
    });

    if (!client?.pageId || !client?.PAGE_ACCESS_TOKEN) {
      console.warn("🟨 No page connected or missing page token:", { clientId });
      return res.status(400).json({ error: "No page connected" });
    }

    const fields = ["messages", "messaging_postbacks", "messaging_optins", "feed"];
    console.log("🟦 Subscribing page to fields:", { pageId: client.pageId, fields });

    const params = new URLSearchParams();
    params.append("subscribed_fields", fields.join(","));
    params.append("access_token", client.PAGE_ACCESS_TOKEN);

    const subUrl = `https://graph.facebook.com/v20.0/${client.pageId}/subscribed_apps`;
    console.log("🟦 Subscribe URL:", subUrl);

    const subRes = await fetch(subUrl, { method: "POST", body: params });
    const subText = await subRes.text();

    console.log("🟦 Subscribe HTTP:", subRes.status);
    console.log("🟦 Subscribe RAW:", subText);

    let subData = {};
    try {
      subData = JSON.parse(subText);
    } catch {
      subData = { raw: subText };
    }

    const ok = Boolean(subData?.success);
    console.log("🟦 Subscribe parsed:", { ok, subData });

    await Client.updateOne(
      { clientId },
      { $set: { webhookSubscribed: ok, webhookFields: fields, webhookSubscribedAt: ok ? new Date() : null } }
    );

    console.log("💾 Stored webhook subscription meta:", { clientId, ok, fields });
    return res.json({ success: ok, fields, subData });
  } catch (err) {
    console.error("❌ /api/webhooks/subscribe error:", err);
    return res.status(500).json({ error: "Subscribe failed" });
  }
});

// ------------------------------
// Webhook status (for dashboard display)
// ------------------------------
app.get("/api/webhooks/status/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    console.log("🟩 /api/webhooks/status called:", { clientId });

    const client = await Client.findOne(
      { clientId },
      "webhookSubscribed webhookFields webhookSubscribedAt lastWebhookAt lastWebhookType"
    ).lean();

    console.log("🟩 Status result:", {
      found: Boolean(client),
      webhookSubscribed: client?.webhookSubscribed,
      lastWebhookAt: client?.lastWebhookAt,
      lastWebhookType: client?.lastWebhookType,
    });

    if (!client) return res.status(404).json({ error: "Client not found" });
    return res.json(client);
  } catch (err) {
    console.error("❌ /api/webhooks/status error:", err);
    return res.status(500).json({ error: "Status failed" });
  }
});

// ------------------------------
// Last webhook payload (for modal)
// ------------------------------
app.get("/api/webhooks/last/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    console.log("🟪 /api/webhooks/last called:", { clientId });

    const client = await Client.findOne(
      { clientId },
      "lastWebhookAt lastWebhookType lastWebhookPayload"
    ).lean();

    console.log("🟪 Last payload meta:", {
      found: Boolean(client),
      lastWebhookAt: client?.lastWebhookAt,
      lastWebhookType: client?.lastWebhookType,
      hasPayload: Boolean(client?.lastWebhookPayload),
    });

    if (!client) return res.status(404).json({ error: "Client not found" });
    return res.json(client);
  } catch (err) {
    console.error("❌ /api/webhooks/last error:", err);
    return res.status(500).json({ error: "Last webhook fetch failed" });
  }
});

// ------------------------------
// Meta webhook verification
// ------------------------------
// Meta webhook verification (keep this)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🧪 Webhook VERIFY hit:", {
    mode,
    tokenReceived: token,
    expected: VERIFY_TOKEN ? "[set]" : "[missing]",
    hasChallenge: Boolean(challenge),
  });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook verification failed");
  return res.sendStatus(403);
});

// ✅ first: save/log payload (no response here)



// ------------------------------
// Meta webhook receiver
// ------------------------------
async function saveLastWebhook(req, res, next) {
  const body = req.body;

  // ✅ logs to confirm you are receiving events
  console.log("🔥 WEBHOOK POST HIT:", new Date().toISOString());
  console.log("🔥 Body top-level keys:", Object.keys(body || {}));

  try {
    const entry0 = body?.entry?.[0];
    console.log("🔥 entry[0] summary:", {
      hasEntry0: Boolean(entry0),
      entry0Id: entry0?.id,
      hasChanges: Boolean(entry0?.changes?.length),
      hasMessaging: Boolean(entry0?.messaging?.length),
    });

    const incomingPageId = entry0?.id;

    const lastType =
      entry0?.changes?.[0]?.field || // "feed"
      (entry0?.messaging ? "messages" : "unknown");

    console.log("🔥 Parsed webhook:", { incomingPageId, lastType });

    if (incomingPageId) {
      const updateRes = await Client.updateOne(
        { pageId: incomingPageId },
        {
          $set: {
            lastWebhookAt: new Date(),
            lastWebhookType: lastType,
            lastWebhookPayload: body,
          },
        }
      );

      console.log("💾 Saved last webhook to Client:", {
        matched: updateRes?.matchedCount,
        modified: updateRes?.modifiedCount,
      });

      if (!updateRes?.matchedCount) {
        console.warn("⚠️ No Client matched for incomingPageId:", incomingPageId);
      }
    } else {
      console.warn("⚠️ No incomingPageId found in webhook body");
    }
  } catch (err) {
    console.error("❌ Failed saving last webhook:", err);
  }

  // ✅ IMPORTANT: let messengerRoute handle replying
  return next();
}

router.post("/api/review/send-test", async (req, res) => {
  try {
    const { pageId, psid, text } = req.body;

    if (!pageId || !psid || !text) {
      return res.status(400).json({ error: "Missing pageId/psid/text" });
    }

    // 1) get Page token from DB
    const db = await connectDB();
    const clients = db.collection("clients"); // change if your collection name differs

    const clientDoc = await clients.findOne({ pageId: String(pageId).trim() });
    if (!clientDoc?.PAGE_ACCESS_TOKEN) {
      return res.status(404).json({ error: "No PAGE_ACCESS_TOKEN found for this pageId" });
    }

    const PAGE_ACCESS_TOKEN = clientDoc.PAGE_ACCESS_TOKEN || clientDoc.PAGE_ACCESS_TOKEN; 
    // ^ adjust this line to match your exact field name (PAGE_ACCESS_TOKEN vs PAGE_ACCESS_TOKEN)

    // 2) call Meta Send API
    const url = `https://graph.facebook.com/v20.0/${pageId}/messages?access_token=${encodeURIComponent(
      PAGE_ACCESS_TOKEN
    )}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text },
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(400).json({ ok: false, metaError: data });
    }

    // success
    return res.json({ ok: true, meta: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

export default router;
// API routes
app.use("/webhook", saveLastWebhook);

// ✅ second: messengerRoute does the real work + sends 200
app.use("/webhook", messengerRoute);

// other routes
app.use("/api/chat", chatRoute);
app.use("/instagram", instagramRoute);

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