// worker.js  ✅ PRODUCTION WORKER (Messenger + WhatsApp)

import { Worker } from "bullmq";
import { MongoClient } from "mongodb";

import { getChatCompletion } from "./services/openai.js";
import { retrieveChunks } from "./services/retrieval.js";
import { buildChatMessages } from "./services/promptBuilder.js";

import { sendMessengerReply } from "./services/messenger.js";
import { sendWhatsAppText } from "./services/whatsappText.js";

if (!process.env.REDIS_URL) {
  console.error("❌ REDIS_URL is required to run worker");
  process.exit(1);
}

const mongoClient = new MongoClient(process.env.MONGODB_URI);
let mongoConnected = false;
const dbName = "Agent";

async function connectDB() {
  if (!mongoConnected) {
    await mongoClient.connect();
    mongoConnected = true;
    console.log("✅ Worker Mongo connected");
  }
  return mongoClient.db(dbName);
}

// ===============================
// Conversation Helpers
// ===============================

async function getConversation(db, clientId, userId, source) {
  return db.collection("Conversations").findOne({
    clientId: String(clientId),
    userId,
    source,
  });
}

async function saveConversation(db, data) {
  await db.collection("Conversations").updateOne(
    { clientId: data.clientId, userId: data.userId, source: data.source },
    {
      $set: {
        ...data,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
        humanEscalation: false,
      },
    },
    { upsert: true }
  );
}

function isNewDay(lastDate) {
  const today = new Date();
  const d = lastDate ? new Date(lastDate) : null;
  return (
    !d ||
    d.getDate() !== today.getDate() ||
    d.getMonth() !== today.getMonth() ||
    d.getFullYear() !== today.getFullYear()
  );
}

// ===============================
// Worker
// ===============================

const worker = new Worker(
  "message-jobs",
  async (job) => {
    const payload = job.data;
    const db = await connectDB();

    const {
      channel,
      clientId,
      pageId,
      phoneNumberId,
      psid,
      waFrom,
      text,
    } = payload;

    const userId = channel === "messenger" ? psid : waFrom;

    const client = await db.collection("Clients").findOne({
      clientId: String(clientId),
      active: { $ne: false },
    });

    if (!client) {
      console.warn("⚠️ Worker: client not found", clientId);
      return;
    }

    const source = channel;
    const convo = await getConversation(db, clientId, userId, source);

    if (convo?.humanEscalation === true) {
      console.log("👤 Human escalation active. Skipping AI.");
      return;
    }

    let history = convo?.history || [
      { role: "system", content: client.systemPrompt || "You are a helpful assistant." },
    ];

    const inboundAt = new Date();
    history.push({ role: "user", content: text, createdAt: inboundAt });

    let greeting = "";
    if (!convo || isNewDay(convo.lastInteraction)) {
      greeting = "Hi 👋";
    }

    // ===============================
    // Retrieval
    // ===============================
    let grouped = {};
    try {
      grouped = await retrieveChunks({
        clientId,
        botType: client.botType || "default",
        userText: text,
      });
    } catch (e) {
      console.warn("⚠️ retrieveChunks failed", e.message);
    }

    const { messages } = buildChatMessages({
      rulesPrompt: client.systemPrompt || "You are a helpful assistant.",
      groupedChunks: grouped,
      userText: text,
      sectionsOrder: client.sectionsOrder || [],
    });

    // ===============================
    // OpenAI
    // ===============================
    let assistantMessage;
    try {
      assistantMessage = await getChatCompletion(messages);
    } catch (err) {
      console.error("❌ OpenAI error:", err.message);
      assistantMessage = "⚠️ I'm having trouble right now. Please try again shortly.";
    }

    const combined = greeting
      ? `${greeting}\n\n${assistantMessage}`
      : assistantMessage;

    history.push({
      role: "assistant",
      content: assistantMessage,
      createdAt: new Date(),
    });

    await saveConversation(db, {
      clientId,
      userId,
      source,
      history,
      lastInteraction: new Date(),
      lastMessage: text.slice(0, 200),
      lastMessageAt: inboundAt,
      lastDirection: "in",
    });

    // ===============================
    // Send Reply
    // ===============================
    if (channel === "messenger") {
      await sendMessengerReply(psid, combined, pageId);
    }

    if (channel === "whatsapp") {
      await sendWhatsAppText({
        phoneNumberId,
        to: waFrom,
        text: combined,
      });
    }

    console.log("✅ Worker processed:", {
      channel,
      clientId,
      preview: combined.slice(0, 80),
    });
  },
  {
    connection: {
      url: process.env.REDIS_URL,
    },
    concurrency: 5,
  }
);

worker.on("completed", (job) => {
  console.log("🎯 Job completed:", job.id);
});

worker.on("failed", (job, err) => {
  console.error("💥 Job failed:", job?.id, err?.message);
});

console.log("👷 Worker started (queue: message-jobs)");
