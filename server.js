// server.js (updated for Instagram connect + review-ready asset visibility)
// ✅ Adds: fetch + store IG handle/name/pfp via connected Page
// ✅ Adds: page picker finalize endpoint (for multi-page users)
// ✅ Tightens: admin-only renew endpoints
// ⚠️ Keep your existing instagram.js for DM/webhook logic — this file just fixes auth + storing the right IG fields.

import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cors from "cors";
import Conversation from "./conversations.js";
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
import ordersRoute from "./routes/orders.js";
import whatsappRoute from "./whatsapp.js";
import knowledgeRoute from "./routes/knowledge.js";
import engagementRoutes from "./routes/engagement.js";
import Product from "./Product.js"; // ✅ this registers the model

const app = express();
dotenv.config();

// -------------------------
// Helpers
// -------------------------
function normalizeUrl(u = "") {
  return String(u).trim().replace(/\/+$/, "");
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${r.statusText}`);
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * ✅ Get connected Instagram professional account for a Page (if any),
 * and fetch reviewer-required fields (handle/name/pfp).
 *
 * Works with Page Access Token.
 */
async function fetchInstagramAccountForPage(pageId, pageAccessToken) {
  // 1) Ask page for its connected IG business account
  const pageFieldsUrl =
    `https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}` +
    `?fields=instagram_business_account{id,username,name,profile_picture_url}` +
    `&access_token=${encodeURIComponent(pageAccessToken)}`;

  const pageData = await fetchJson(pageFieldsUrl);
  const ig = pageData?.instagram_business_account;

  if (!ig?.id) {
    return {
      hasInstagram: false,
      igId: "",
      igUsername: "",
      igName: "",
      igProfilePicUrl: "",
    };
  }

  // 2) Some accounts return limited fields above; fetch again from IG node to be safe
  const igFieldsUrl =
    `https://graph.facebook.com/v20.0/${encodeURIComponent(ig.id)}` +
    `?fields=id,username,name,profile_picture_url` +
    `&access_token=${encodeURIComponent(pageAccessToken)}`;

  const igData = await fetchJson(igFieldsUrl);

  return {
    hasInstagram: true,
    igId: String(igData?.id || ig.id || ""),
    igUsername: String(igData?.username || ig.username || ""),
    igName: String(igData?.name || ig.name || ""),
    igProfilePicUrl: String(igData?.profile_picture_url || ig.profile_picture_url || ""),
  };
}

// -------------------------
// Middleware
// -------------------------
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5500",
      "https://dashboardai1.netlify.app",
      "https://dashboardai1.netlify.app/client",
      "https://dashboardai1.netlify.app/admin",
    ],
     origin: true,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ✅ Ensure uploads folder exists
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// ✅ Multer config (safe file upload)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

// ✅ File filter: allow only safe types
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "application/pdf",
    "application/json",
  ];
  if (allowedTypes.includes(file.mimetype)) cb(null, true);
  else cb(new Error("❌ Invalid file type. Only TXT, MD, CSV, TSV, PDF, JSON allowed."), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

// ✅ Helper: Clean and normalize file content
function cleanFileContent(content, mimetype) {
  let cleaned = String(content || "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (mimetype === "text/csv" || mimetype === "text/tab-separated-values") {
    const rows = cleaned.split("\n").map((r) => r.split(/,|\t/).join(" | "));
    cleaned = rows.join("\n");
  }

  if (mimetype === "application/json") {
    try {
      const parsed = JSON.parse(content);
      cleaned = JSON.stringify(parsed, null, 2);
    } catch {
      // leave as-is
    }
  }

  return cleaned;
}

export function verifyToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, clientId }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function attachClientId(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role === "client") req.query.clientId = req.user.clientId;
  next();
}

function requireClientOwnership(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role === "admin") return next();
  if (req.user.role === "client") {
    const paramId = req.params.clientId || req.params.id;
    if (paramId && paramId !== req.user.clientId) return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  next();
}

// Serve uploaded files safely
app.use("/uploads", express.static(uploadDir));

// Root route
app.get("/", (req, res) => res.send("✅ Server is running!"));

// ✅ File upload route (basic)
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "❌ No file uploaded" });
  res.json({
    message: "✅ File uploaded successfully",
    filename: req.file.filename,
    path: `/uploads/${req.file.filename}`,
    size: req.file.size,
  });
});

// ✅ Upload file & save into Client.files[]
app.post("/upload/:clientId", verifyToken, requireClientOwnership, upload.single("file"), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name } = req.body;

    if (!req.file) return res.status(400).json({ error: "❌ No file uploaded" });

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
    if (!client) return res.status(404).json({ error: "❌ Client not found" });

    client.files.push({ name: name || req.file.originalname, content });
    await client.save();

    res.json({ message: "✅ File uploaded, cleaned, and saved to client", client });
  } catch (err) {
    console.error("❌ Error saving file to client:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Remove a file from Client.files[] by its _id
app.delete("/clients/:clientId/files/:fileId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId, fileId } = req.params;

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "❌ Client not found" });

    client.files = client.files.filter((f) => f._id.toString() !== fileId);
    await client.save();

    res.json({ message: "✅ File removed", client });
  } catch (err) {
    console.error("❌ Error deleting file:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------
// ✅ Minimal WARNINGS endpoint (NEW)
// ------------------------------------
app.get("/api/clients/:clientId/health", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ error: "Client not found" });

    const warnings = [];

    const used = client.messageCount || 0;
    const quota = client.messageLimit || 0;
    if (quota > 0) {
      const ratio = used / quota;
      if (ratio >= 0.9) {
        warnings.push({ code: "QUOTA_HIGH", severity: "warn", message: "You are close to your message quota (90%+ used)." });
      }
    }

    if (client.pageId && !client.PAGE_ACCESS_TOKEN) {
      warnings.push({
        code: "PAGE_TOKEN_MISSING",
        severity: "error",
        message: "Facebook Page is connected but page access token is missing.",
      });
    }

    if (client.pageId) {
      const lastWebhookAt = client.lastWebhookAt ? new Date(client.lastWebhookAt) : null;
      const staleMs = 24 * 60 * 60 * 1000;

      if (!lastWebhookAt) {
        warnings.push({
          code: "WEBHOOK_NEVER",
          severity: "warn",
          message: "No webhook has been received yet. Trigger a test message/comment and refresh.",
        });
      } else if (Date.now() - lastWebhookAt.getTime() > staleMs) {
        warnings.push({ code: "WEBHOOK_STALE", severity: "warn", message: "No webhook received in the last 24 hours." });
      }
    }

    const latest = await Conversation.findOne({ clientId }).sort({ updatedAt: -1 }).lean();
    if (latest?.history?.length) {
      if (latest.history.length > 40) {
        warnings.push({
          code: "PROMPT_RISK_LONG_CHAT",
          severity: "warn",
          message: "Conversation is long; replies may get cut. Consider starting a fresh chat for best results.",
        });
      }

      const maxLen = latest.history.reduce((m, msg) => Math.max(m, String(msg?.content || "").length), 0);
      if (maxLen > 6000) {
        warnings.push({
          code: "PROMPT_RISK_LONG_MESSAGE",
          severity: "warn",
          message: "A message is very long; replies may get cut. Try shorter questions or split into parts.",
        });
      }
    }

    const totalChars = (client.files || []).reduce((sum, f) => sum + String(f?.content || "").length, 0);
    if (totalChars > 100000) {
      warnings.push({
        code: "KB_LARGE",
        severity: "warn",
        message: "Knowledge base is large. If answers miss details, enable chunk retrieval limits in settings.",
      });
    }

    const status =
      warnings.some((w) => w.severity === "error") ? "error" : warnings.length ? "warning" : "ok";

    return res.json({
      ok: true,
      status,
      warnings,
      meta: {
        used,
        quota,
        lastWebhookAt: client.lastWebhookAt || null,
        hasPage: Boolean(client.pageId),
        hasInstagram: Boolean(client.igId),
        igUsername: client.igUsername || "",
      },
    });
  } catch (err) {
    console.error("❌ /api/clients/:clientId/health error:", err);
    return res.status(500).json({ error: "Health check failed" });
  }
});

// ------------------------------------
// Clients endpoints
// ------------------------------------
app.get("/api/clients/:id", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { id } = req.params;
    const client = await Client.findOne({ clientId: id });
    if (!client) return res.status(404).json({ error: "Client not found" });

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
      PAGE_NAME: client.PAGE_NAME || "",
      PAGE_ACCESS_TOKEN: client.PAGE_ACCESS_TOKEN || "",

      igId: client.igId || "",
      igUsername: client.igUsername || "",
      igName: client.igName || "",
      igProfilePicUrl: client.igProfilePicUrl || "",
      igAccessToken: client.igAccessToken || "",

      used: client.messageCount || 0,
      quota: client.messageLimit || 0,
      remaining: (client.messageLimit || 0) - (client.messageCount || 0),

      files: client.files || [],
      lastActive: client.updatedAt || client.createdAt,
      systemPrompt: client.systemPrompt || "",
      faqs: client.faqs || "",
      active: client.active ?? false,

      totalHumanRequests: convoStats.totalHumanRequests || 0,
      totalTourRequests: convoStats.totalTourRequests || 0,
      totalorderRequests: convoStats.totalorderRequests || 0,
      activeHumanChats: convoStats.activeHumanChats || 0,
          whatsappWabaId: client.whatsappWabaId,
      whatsappPhoneNumberId: client.whatsappPhoneNumberId,
      whatsappDisplayPhone: client.whatsappDisplayPhone,
      whatsappConnectedAt: client.whatsappConnectedAt,
      whatsappTokenExpiresAt: client.whatsappTokenExpiresAt,
    });
  } catch (err) {
    console.error("❌ Error fetching client:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------
// ✅ STATS ROUTES (copied from old server.js)
// ------------------------------------

// Dashboard stats route (admin)
app.get("/api/stats", verifyToken, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const totalClients = await Client.countDocuments();
    const clients = await Client.find();

    const convoStats = await Conversation.aggregate([
      {
        $group: {
          _id: null,
          totalHumanRequests: { $sum: "$humanRequestCount" },
          totalTourRequests: { $sum: "$tourRequestCount" },
          totalorderRequests: { $sum: "$orderRequestCount" },
          activeHumanChats: { $sum: { $cond: ["$humanEscalation", 1, 0] } },
        },
      },
    ]);

    const globalStats = convoStats[0] || {
      totalHumanRequests: 0,
      totalTourRequests: 0,
      totalorderRequests: 0,
      activeHumanChats: 0,
    };

    const used = clients.reduce((sum, c) => sum + (c.messageCount || 0), 0);
    const quota = clients.reduce((sum, c) => sum + (c.messageLimit || 0), 0);
    const remaining = quota - used;

    const { mode } = req.query;
    let pipeline = [];

    if (mode === "daily") {
      pipeline = [
        { $unwind: "$history" },
        {
          $match: {
            "history.role": "user",
            "history.createdAt": { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
        },
        { $group: { _id: { $hour: "$history.createdAt" }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ];
    } else if (mode === "weekly") {
      pipeline = [
        { $unwind: "$history" },
        {
          $match: {
            "history.role": "user",
            "history.createdAt": { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
        { $group: { _id: { $dayOfWeek: "$history.createdAt" }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ];
    } else if (mode === "monthly") {
      pipeline = [
        { $unwind: "$history" },
        {
          $match: {
            "history.role": "user",
            "history.createdAt": { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        },
        { $group: { _id: { $dayOfMonth: "$history.createdAt" }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ];
    }

    const chartResults = pipeline.length > 0 ? await Conversation.aggregate(pipeline) : [];

    const perClientStatsArr = await Conversation.aggregate([
      {
        $group: {
          _id: "$clientId",
          humanRequests: { $sum: "$humanRequestCount" },
          tourRequests: { $sum: "$tourRequestCount" },
          orderRequests: { $sum: "$orderRequestCount" },
        },
      },
    ]);

    const statsMap = {};
    perClientStatsArr.forEach((s) => {
      statsMap[s._id] = {
        humanRequests: s.humanRequests || 0,
        tourRequests: s.tourRequests || 0,
        orderRequests: s.orderRequests || 0,
      };
    });

    const clientsData = clients.map((c) => {
      const used = c.messageCount || 0;
      const quota = c.messageLimit || 0;
      const remaining = quota - used;
      const clientStats = statsMap[c.clientId] || {};

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
        igAccessToken: c.igAccessToken || "",
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
      clients: clientsData,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// stats by client
app.get("/api/stats/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ error: "❌ Client not found" });
    }

    const used = client.messageCount || 0;
    const quota = client.messageLimit || 0;
    const remaining = quota - used;

    const { mode } = req.query;

    let pipeline = [{ $match: { clientId } }, { $unwind: "$history" }, { $match: { "history.role": "user" } }];

    const now = new Date();

    if (mode === "daily") {
      pipeline.push({ $match: { "history.createdAt": { $gte: new Date(now.setHours(0, 0, 0, 0)) } } });
      pipeline.push({ $group: { _id: { $hour: "$history.createdAt" }, count: { $sum: 1 } } });
    } else if (mode === "weekly") {
      pipeline.push({ $match: { "history.createdAt": { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } });
      pipeline.push({ $group: { _id: { $dayOfWeek: "$history.createdAt" }, count: { $sum: 1 } } });
    } else if (mode === "monthly") {
      pipeline.push({ $match: { "history.createdAt": { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } });
      pipeline.push({ $group: { _id: { $dayOfMonth: "$history.createdAt" }, count: { $sum: 1 } } });
    }

    pipeline.push({ $sort: { _id: 1 } });

    const chartResults = await Conversation.aggregate(pipeline);

    const clientConvos = await Conversation.find({ clientId });

    const totalHumanRequests = clientConvos.reduce((sum, c) => sum + (c.humanRequestCount || 0), 0);
    const totalTourRequests = clientConvos.reduce((sum, c) => sum + (c.tourRequestCount || 0), 0);
    const orderRequestCount = clientConvos.reduce((sum, c) => sum + (c.orderRequestCount || 0), 0);
    const activeHumanChats = clientConvos.reduce((sum, c) => sum + (c.humanEscalation ? 1 : 0), 0);

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
      activeHumanChats,
    });
  } catch (err) {
    console.error("❌ Error fetching client stats:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------------
// Admin renew (secured)
// ----------------------
app.post("/admin/renew/:clientId", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "❌ Client not found" });

    const now = new Date();
    const nextMonth = new Date();
    nextMonth.setMonth(now.getMonth() + 1);

    await Client.updateOne(
      { clientId },
      {
        $set: {
          messageCount: 0,
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

app.post("/admin/renew-all", verifyToken, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const nextMonth = new Date();
    nextMonth.setMonth(now.getMonth() + 1);

    await Client.updateMany({}, {
      $set: {
        messageCount: 0,
        quotaWarningSent: false,
        currentPeriodStart: now,
        currentPeriodEnd: nextMonth,
      },
    });

    res.json({ success: true, message: "All clients renewed successfully" });
  } catch (err) {
    console.error("❌ Renew-all error:", err);
    res.status(500).json({ error: "Server error during renew-all" });
  }
});

// ------------------------------------
// Auth / Users
// ------------------------------------
app.post("/api/create-admin", async (req, res) => {
  try {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = new User({ email, password: hashedPassword, role: "admin" });
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

    const clientUser = new User({ name, email, password: hashedPassword, role: "client", clientId });
    await clientUser.save();
    res.json({ message: "✅ Client user created", clientUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "❌ Error creating client user" });
  }
});

// ⚠️ NOTE: keep if you want, but ideally guard in production
async function createAdmin() {
  try {
    const existing = await User.findOne({ role: "admin" });
    if (existing) return console.log("Admin already exists");

    const admin = new User({
      name: "YASSO",
      email: "yassin.ismail2005@gmail.com",
      password: await bcrypt.hash("admin123", 10),
      role: "admin",
      clientId: null,
    });

    await admin.save();
    console.log("✅ Admin created:", admin);
  } catch (e) {
    console.log("⚠️ createAdmin failed:", e?.message);
  }
}
createAdmin();

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      name,
      email,
      password: hashedPassword,
      role: "client",
      clientId: new mongoose.Types.ObjectId().toString(),
    });
    await user.save();

    const client = new Client({
      name,
      email,
      clientId: user.clientId,
      messageLimit: 100,
      messageCount: 0,
      files: [],
    });
    await client.save();

    const token = jwt.sign({ id: user._id, role: user.role, clientId: user.clientId }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

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

    const token = jwt.sign({ id: user._id, role: user.role, clientId: user.clientId }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 1000 * 60 * 60,
    });

    res.json({ role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/me", verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      id: user._id,
      email: user.email,
      role: user.role,
      clientId: user.clientId || null,
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

    if (clientData.quota !== undefined) {
      clientData.messageLimit = clientData.quota;
      delete clientData.quota;
    }

    const client = await Client.findOneAndUpdate({ clientId: req.params.id }, clientData, {
      new: true,
      runValidators: true,
    });

    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (err) {
    console.error("❌ Error updating client:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Delete client (admin only)
app.delete("/api/clients/:id", verifyToken, requireAdmin, async (req, res) => {
  try {
    const client = await Client.findOneAndDelete({ clientId: req.params.id });
    if (!client) return res.status(404).json({ error: "Client not found" });

    await User.findOneAndDelete({ clientId: req.params.id });
    res.json({ message: "✅ Client and linked user deleted" });
  } catch (err) {
    console.error("❌ Error deleting client & user:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Get all conversations (admin only)
app.get("/api/conversations", verifyToken, requireAdmin, async (req, res) => {
  try {
    const { source } = req.query;
    const query = source ? { source } : {};

    let conversations = await Conversation.find(query).sort({ updatedAt: -1 }).lean();
    conversations = conversations.map((convo) => ({
      ...convo,
      history: convo.history.filter((msg) => msg.role !== "system"),
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
    const { source } = req.query;
    const query = source ? { clientId, source } : { clientId };

    const conversations = await Conversation.find(query).lean();
    conversations.forEach((c) => { c.history = c.history.filter((msg) => msg.role !== "system"); });

    res.json(conversations);
  } catch (err) {
    console.error("❌ Error fetching client conversations:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Health check endpoint
app.get("/health", async (req, res) => {
  try {
    if (!mongoose.connection?.db) return res.status(500).json({ status: "error", error: "DB not connected" });
    await mongoose.connection.db.admin().ping();
    res.json({ status: "ok", time: new Date().toISOString() });
  } catch (err) {
    console.error("❌ Health check failed:", err.message);
    res.status(500).json({ status: "error", error: err.message });
  }
});

// --------------------
// 🌐 FACEBOOK OAUTH FLOW (Page + IG asset fetch + store)
// --------------------

// OAuth START
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
      `&response_type=code` +
      `&auth_type=rerequest` +
      `&config_id=${encodeURIComponent(process.env.FACEBOOK_LOGIN_CONFIG_ID)}` +
      `&business_id=1477713280210878` +
      `&state=${encodeURIComponent(clientId)}`;

    console.log("CONFIG_ID:", process.env.FACEBOOK_LOGIN_CONFIG_ID);
    console.log("🔁 OAuth START redirect_uri:", redirectUri);
    return res.redirect(fbAuthUrl);
  } catch (err) {
    console.error("❌ Error starting Facebook OAuth:", err);
    return res.status(500).send("OAuth start error");
  }
});

async function upsertClientConnection({
  clientId,
  pageId,
  pageName,
  PAGE_ACCESS_TOKEN,
  userAccessToken,
  webhookSubscribed,
  webhookFields,
  ig, // { igId, igUsername, igName, igProfilePicUrl, hasInstagram }
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

        // ✅ Instagram identity fields (review needs handle visible)
        igId: ig?.igId || "",
        igUsername: ig?.igUsername || "",
        igName: ig?.igName || "",
        igProfilePicUrl: ig?.igProfilePicUrl || "",

        // ✅ Use the same Page token for IG Graph calls in most cases
        igAccessToken: PAGE_ACCESS_TOKEN,

        webhookSubscribed: Boolean(webhookSubscribed),
        webhookFields: webhookFields || [],
        webhookSubscribedAt: webhookSubscribed ? new Date() : null,
      },
    },
    { upsert: true }
  );
}
async function upsertClientWhatsAppConnection({
  clientId,
  whatsappWabaId,
  whatsappPhoneNumberId,
  whatsappAccessToken,
  whatsappDisplayPhone,
  whatsappTokenExpiresAt,
  whatsappTokenType = "user",
}) {
  await Client.updateOne(
    { clientId },
    {
      $set: {
        whatsappWabaId: whatsappWabaId || "",
        whatsappPhoneNumberId: whatsappPhoneNumberId || "",
        whatsappAccessToken: whatsappAccessToken || "",
        whatsappDisplayPhone: whatsappDisplayPhone || "",
        whatsappConnectedAt: new Date(),
        whatsappTokenExpiresAt: whatsappTokenExpiresAt || null,
        whatsappTokenType,
      },
    },
    { upsert: true }
  );
}
// ✅ Page picker finalize (when user has multiple pages)
// Frontend calls this after user chooses a page.
// POST /api/pages/select { clientId, pageId }
app.post("/api/pages/select", verifyToken, async (req, res) => {
  try {
    const { clientId, pageId } = req.body || {};
    if (!clientId || !pageId) return res.status(400).json({ error: "Missing clientId/pageId" });

    // Ownership: client can only select their own clientId
    if (req.user.role === "client" && req.user.clientId !== clientId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const client = await Client.findOne({ clientId }).lean();
    if (!client?.userAccessToken) return res.status(400).json({ error: "Missing userAccessToken. Reconnect." });

    // Fetch this page with access_token included
    const pageUrl =
      `https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}` +
      `?fields=id,name,access_token` +
      `&access_token=${encodeURIComponent(client.userAccessToken)}`;

    const pageData = await fetchJson(pageUrl);
    const PAGE_ACCESS_TOKEN = pageData?.access_token;
    const pageName = pageData?.name;

    if (!PAGE_ACCESS_TOKEN) return res.status(400).json({ error: "Could not get Page access token" });

    // Subscribe page webhooks
    const fields = ["messages", "messaging_postbacks", "messaging_optins", "feed"];
    let webhookSubscribed = false;

    try {
      const params = new URLSearchParams();
      params.append("subscribed_fields", fields.join(","));
      params.append("access_token", PAGE_ACCESS_TOKEN);
      const subUrl = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`;
      const subData = await fetchJson(subUrl, { method: "POST", body: params });
      webhookSubscribed = Boolean(subData?.success);
    } catch (e) {
      console.error("❌ Webhook subscription failed (page picker):", e?.data || e?.message);
    }

    // ✅ Fetch IG account connected to this page
    let ig = null;
    try {
      ig = await fetchInstagramAccountForPage(pageId, PAGE_ACCESS_TOKEN);
    } catch (e) {
      console.error("❌ IG fetch failed (page picker):", e?.data || e?.message);
      ig = { hasInstagram: false, igId: "", igUsername: "", igName: "", igProfilePicUrl: "" };
    }

    await upsertClientConnection({
      clientId,
      pageId,
      pageName,
      PAGE_ACCESS_TOKEN,
      userAccessToken: client.userAccessToken,
      webhookSubscribed,
      webhookFields: fields,
      ig,
    });

    return res.json({
      ok: true,
      page: { pageId, pageName },
      instagram: ig,
      webhookSubscribed,
      webhookFields: fields,
    });
  } catch (err) {
    console.error("❌ /api/pages/select error:", err?.data || err);
    return res.status(500).json({ error: "Page select failed" });
  }
});

// OAuth CALLBACK
app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state } = req.query;
  const clientId = state;

  if (!code || !clientId) return res.status(400).send("Missing OAuth code or clientId");

  const redirectUri = normalizeUrl(process.env.FACEBOOK_REDIRECT_URI);
  const FRONTEND_URL = normalizeUrl(process.env.FRONTEND_URL || "http://localhost:5173");
  if (!redirectUri) return res.status(500).send("Missing FACEBOOK_REDIRECT_URI");

  try {
    console.log("🔁 OAuth CALLBACK redirect_uri:", redirectUri);

    // 1) Exchange code -> user access token
    const tokenUrl =
      `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(process.env.FACEBOOK_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_secret=${encodeURIComponent(process.env.FACEBOOK_APP_SECRET)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenData = await fetchJson(tokenUrl);
    if (!tokenData.access_token) return res.status(400).send("Failed to get user access token");
    const userAccessToken = tokenData.access_token;

    // 2) Get user's managed Pages
    const pagesUrl =
      `https://graph.facebook.com/v20.0/me/accounts` +
      `?fields=id,name,access_token` +
      `&access_token=${encodeURIComponent(userAccessToken)}`;

    const pagesData = await fetchJson(pagesUrl);
    if (!pagesData.data || pagesData.data.length === 0) return res.status(400).send("No managed pages found");

    // Multiple pages -> store userAccessToken, let frontend pick page, then call /api/pages/select
    if (pagesData.data.length > 1) {
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

    if (!pageId || !PAGE_ACCESS_TOKEN) return res.status(400).send("Invalid Page data");

    // 3) Subscribe Page to Webhooks
    const fields = ["messages", "messaging_postbacks", "messaging_optins", "feed"];
    let webhookSubscribed = false;

    try {
      const params = new URLSearchParams();
      params.append("subscribed_fields", fields.join(","));
      params.append("access_token", PAGE_ACCESS_TOKEN);
      const subUrl = `https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`;
      const subData = await fetchJson(subUrl, { method: "POST", body: params });
      webhookSubscribed = Boolean(subData?.success);
    } catch (err) {
      console.error("❌ Webhook subscription failed (OAuth):", err?.data || err?.message);
    }

    // ✅ 3.5) Fetch IG identity from connected Page (store handle for review)
    let ig = null;
    try {
      ig = await fetchInstagramAccountForPage(pageId, PAGE_ACCESS_TOKEN);
    } catch (e) {
      console.error("❌ IG fetch failed (OAuth):", e?.data || e?.message);
      ig = { hasInstagram: false, igId: "", igUsername: "", igName: "", igProfilePicUrl: "" };
    }

    // 4) Store everything
    await upsertClientConnection({
      clientId,
      pageId,
      pageName,
      PAGE_ACCESS_TOKEN,
      userAccessToken,
      webhookSubscribed,
      webhookFields: fields,
      ig,
    });

    // 5) Redirect back
    // Include ig handle so you can display instantly in UI (good for review)
    return res.redirect(
      `${FRONTEND_URL}/client?connected=success` +
        `&pageId=${encodeURIComponent(pageId)}` +
        `&pageName=${encodeURIComponent(pageName)}` +
        `&igId=${encodeURIComponent(ig?.igId || "")}` +
        `&igUsername=${encodeURIComponent(ig?.igUsername || "")}`
    );
  } catch (err) {
    console.error("❌ OAuth callback error:", err?.data || err);
    return res.status(500).send("OAuth callback error");
  }
});

// ------------------------------
// Visible "Enable Webhooks" action (SECURED)
// ------------------------------
app.post("/api/webhooks/subscribe/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne({ clientId }).lean();
    if (!client?.pageId || !client?.PAGE_ACCESS_TOKEN) {
      return res.status(400).json({ error: "No page connected" });
    }

    const fields = ["messages", "messaging_postbacks", "messaging_optins", "feed"];

    const params = new URLSearchParams();
    params.append("subscribed_fields", fields.join(","));
    params.append("access_token", client.PAGE_ACCESS_TOKEN);

    const subUrl = `https://graph.facebook.com/v20.0/${client.pageId}/subscribed_apps`;

    let ok = false;
    let subData = {};
    try {
      subData = await fetchJson(subUrl, { method: "POST", body: params });
      ok = Boolean(subData?.success);
    } catch (e) {
      console.error("❌ /api/webhooks/subscribe error:", e?.data || e?.message);
      ok = false;
      subData = e?.data || { error: String(e?.message || e) };
    }

    await Client.updateOne(
      { clientId },
      { $set: { webhookSubscribed: ok, webhookFields: fields, webhookSubscribedAt: ok ? new Date() : null } }
    );

    return res.json({ success: ok, fields, subData });
  } catch (err) {
    console.error("❌ /api/webhooks/subscribe fatal:", err);
    return res.status(500).json({ error: "Subscribe failed" });
  }
});

app.get("/api/webhooks/status/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne(
      { clientId },
      "webhookSubscribed webhookFields webhookSubscribedAt lastWebhookAt lastWebhookType"
    ).lean();

    if (!client) return res.status(404).json({ error: "Client not found" });
    return res.json(client);
  } catch (err) {
    console.error("❌ /api/webhooks/status error:", err);
    return res.status(500).json({ error: "Status failed" });
  }
});

app.get("/api/webhooks/last/:clientId", verifyToken, requireClientOwnership, async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne({ clientId }, "lastWebhookAt lastWebhookType lastWebhookPayload").lean();
    if (!client) return res.status(404).json({ error: "Client not found" });
    return res.json(client);
  } catch (err) {
    console.error("❌ /api/webhooks/last error:", err);
    return res.status(500).json({ error: "Last webhook fetch failed" });
  }
});
app.get("/auth/whatsapp", async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).send("Missing clientId");

    const redirectUri = normalizeUrl(process.env.WHATSAPP_REDIRECT_URI);
    if (!redirectUri) return res.status(500).send("Missing WHATSAPP_REDIRECT_URI");
    if (!process.env.WP_CONFIG) return res.status(500).send("Missing WP_CONFIG");
    if (!process.env.META_BUSINESS_ID) return res.status(500).send("Missing META_BUSINESS_ID");

    const scope = [
      "business_management",
      "whatsapp_business_management",
      "whatsapp_business_messaging",
    ].join(",");

    const authUrl =
      `https://www.facebook.com/v20.0/dialog/oauth` +
      `?client_id=${encodeURIComponent(process.env.FACEBOOK_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&override_default_response_type=true` +
      `&auth_type=rerequest` +
      `&config_id=${encodeURIComponent(process.env.WP_CONFIG)}` +
      `&business_id=${encodeURIComponent(process.env.META_BUSINESS_ID)}` + // ✅ FORCE BUSINESS
      `&state=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(scope)}`;

    return res.redirect(authUrl);
  } catch (err) {
    console.error("❌ Error starting WhatsApp OAuth:", err?.data || err);
    return res.status(500).send("WhatsApp OAuth start error");
  }
});
app.get("/auth/whatsapp/callback", async (req, res) => {
  const { code, state } = req.query;
  const clientId = state;

  if (!code || !clientId) return res.status(400).send("Missing OAuth code or clientId");

  const redirectUri = normalizeUrl(process.env.WHATSAPP_REDIRECT_URI);
  const FRONTEND_URL = normalizeUrl(process.env.FRONTEND_URL || "http://localhost:5173");
  const businessId = process.env.META_BUSINESS_ID;

  if (!redirectUri) return res.status(500).send("Missing WHATSAPP_REDIRECT_URI");
  if (!businessId) return res.status(500).send("Missing META_BUSINESS_ID");

  try {
    console.log("🔁 WHATSAPP OAUTH CALLBACK redirect_uri:", redirectUri);
    console.log("🏢 Using META_BUSINESS_ID:", businessId);

    // 1) Exchange code -> user access token
    const tokenUrl =
      `https://graph.facebook.com/v20.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(process.env.FACEBOOK_APP_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_secret=${encodeURIComponent(process.env.FACEBOOK_APP_SECRET)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenData = await fetchJson(tokenUrl);
    const userAccessToken = tokenData?.access_token;

    if (!userAccessToken) {
      console.error("❌ tokenData:", tokenData);
      return res.status(400).send("Failed to get user access token");
    }

    const whatsappTokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
      : null;

    // 2) (Optional) Debug scopes
    try {
      const debugUrl =
        `https://graph.facebook.com/v20.0/debug_token` +
        `?input_token=${encodeURIComponent(userAccessToken)}` +
        `&access_token=${encodeURIComponent(process.env.FACEBOOK_APP_ID + "|" + process.env.FACEBOOK_APP_SECRET)}`;
      const debug = await fetchJson(debugUrl);
      console.log(
        "🔎 debug_token scopes:",
        JSON.stringify(debug?.data?.scopes || debug?.data?.granular_scopes || debug, null, 2)
      );
    } catch (e) {
      console.log("ℹ️ debug_token skipped/failed:", e?.data || e?.message);
    }

    // 3) From Business -> get WABAs
    const wabasUrl =
      `https://graph.facebook.com/v20.0/${encodeURIComponent(businessId)}/owned_whatsapp_business_accounts` +
      `?fields=id,name` +
      `&access_token=${encodeURIComponent(userAccessToken)}`;

    const wabasData = await fetchJson(wabasUrl);
    const wabas = wabasData?.data || [];

    console.log("📦 owned_whatsapp_business_accounts:", wabas.map(w => ({ id: w.id, name: w.name })));

    if (!wabas.length) {
      return res
        .status(400)
        .send("No WhatsApp Business Accounts found under this META_BUSINESS_ID. Check that the WABA is owned by this business.");
    }

    // MVP: pick first WABA
    const whatsappWabaId = wabas[0].id;

    // 4) From WABA -> phone numbers
    const phonesUrl =
      `https://graph.facebook.com/v20.0/${encodeURIComponent(whatsappWabaId)}/phone_numbers` +
      `?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status` +
      `&access_token=${encodeURIComponent(userAccessToken)}`;

    const phonesData = await fetchJson(phonesUrl);
    const phones = phonesData?.data || [];

    console.log("📞 phone_numbers:", phones.map(p => ({ id: p.id, display: p.display_phone_number, name: p.verified_name })));

    if (!phones.length) {
      return res.status(400).send("No phone numbers found in this WABA.");
    }

    const whatsappPhoneNumberId = phones[0].id;
    const whatsappDisplayPhone = phones[0].display_phone_number || "";

    // 5) Store in Mongo (your schema fields)
    await upsertClientWhatsAppConnection({
      clientId,
      whatsappWabaId,
      whatsappPhoneNumberId,
      whatsappAccessToken: userAccessToken,
      whatsappDisplayPhone,
      whatsappTokenExpiresAt,
      whatsappTokenType: "user",
    });

    // 6) Redirect back
    return res.redirect(
      `${FRONTEND_URL}/client?whatsapp=connected` +
        `&clientId=${encodeURIComponent(clientId)}` +
        `&wabaId=${encodeURIComponent(whatsappWabaId)}` +
        `&phoneNumberId=${encodeURIComponent(whatsappPhoneNumberId)}` +
        `&display=${encodeURIComponent(whatsappDisplayPhone)}`
    );
  } catch (err) {
    console.error("❌ WhatsApp OAuth callback error:", err?.data || err);
    return res.status(500).send("WhatsApp OAuth callback error");
  }
});

// ------------------------------
// Meta webhook receiver saveLastWebhook
// ------------------------------
async function saveLastWebhook(req, res, next) {
  const body = req.body;

  console.log("🔥 WEBHOOK POST HIT:", new Date().toISOString());
  console.log("🔥 Body top-level keys:", Object.keys(body || {}));

  try {
    const entry0 = body?.entry?.[0];
    const incomingPageId = entry0?.id;
    const lastType = entry0?.changes?.[0]?.field || (entry0?.messaging ? "messages" : "unknown");

    if (incomingPageId) {
      await Client.updateOne(
        { pageId: incomingPageId },
        {
          $set: {
            lastWebhookAt: new Date(),
            lastWebhookType: lastType,
            lastWebhookPayload: body,
          },
        }
      );
    }
  } catch (err) {
    console.error("❌ Failed saving last webhook:", err);
  }

  return next();
}

// ✅ Review test send (Messenger) — keep
app.post("/api/review/send-test", async (req, res) => {
  console.log("✅ /api/review/send-test HIT", req.body);

  try {
    const { pageId, psid, text } = req.body;

    if (!pageId || !psid || !text) {
      return res.status(400).json({ error: "Missing pageId / psid / text" });
    }

    const client = await Client.findOne({ pageId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const PAGE_ACCESS_TOKEN = client.PAGE_ACCESS_TOKEN;
    if (!PAGE_ACCESS_TOKEN) return res.status(404).json({ error: "Page access token not found" });

    const url = `https://graph.facebook.com/v20.0/${pageId}/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: { text },
      }),
    });

    const data = await r.json();
    console.log("📨 META RESPONSE:", data);

    if (!r.ok) return res.status(400).json({ ok: false, metaError: data });
    return res.json({ ok: true, meta: data });
  } catch (err) {
    console.error("❌ SEND TEST ERROR:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ------------------------------------
// API routes
// ------------------------------------
app.use("/webhook", saveLastWebhook);
app.use("/webhook", messengerRoute);

app.use("/api/chat", chatRoute);
app.use("/instagram", instagramRoute);
app.use("/whatsapp", whatsappRoute);
app.use("/api", ordersRoute);
app.use("/api/knowledge", knowledgeRoute);
app.use("/api/engagement", verifyToken, attachClientId, engagementRoutes);

// ✅ MongoDB connection + start server
const MONGODB_URI = process.env.MONGODB_URI;

mongoose
  .connect(MONGODB_URI, { dbName: "Agent" })
  .then(() => {
    console.log("✅ MongoDB connected:", mongoose.connection.name);
    console.log("📂 Collections:", Object.keys(mongoose.connection.collections));
    app.listen(3000, () => console.log("🚀 Server running on port 3000"));
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));
