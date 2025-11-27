import express from "express";
import { getChatCompletion } from "./services/openai.js";
import { SYSTEM_PROMPT } from "./utils/systemPrompt.js";
import { sendQuotaWarning } from "./sendQuotaWarning.js";
import { sendTourEmail } from "./sendEmail.js";
import { extractTourData } from "./extractTourData.js";
import { MongoClient } from "mongodb";
import crypto from "crypto";

const router = express.Router();

const mongoClient = new MongoClient(process.env.MONGODB_URI);
const dbName = "Agent";

// ===== DB Connection =====
async function connectDB() {
    if (!mongoClient.topology?.isConnected()) {
        await mongoClient.connect();
    }
    return mongoClient.db(dbName);
}

// ===== Customers =====
async function findOrCreateCustomer(customerId, clientId) {
    const db = await connectDB();
    const customers = db.collection("Customers");

    let customer = await customers.findOne({ customerId, clientId });
    if (!customer) {
        await customers.insertOne({
            customerId,
            clientId,
            name: null,
            lastInteraction: new Date()
        });
        return null;
    } else {
        await customers.updateOne(
            { customerId, clientId },
            { $set: { lastInteraction: new Date() } }
        );
        return customer.name;
    }
}

async function updateCustomerName(customerId, clientId, name) {
    const db = await connectDB();
    const customers = db.collection("Customers");

    await customers.updateOne(
        { customerId, clientId },
        { $set: { name, lastInteraction: new Date() } }
    );
}

// ===== Conversations =====
async function getConversation(clientId, userId) {
    const db = await connectDB();
    const conversations = db.collection("Conversations");
    return await conversations.findOne({ clientId, userId });
}

async function saveConversation(clientId, userId, history) {
    const db = await connectDB();
    const conversations = db.collection("Conversations");
    await conversations.updateOne(
        { clientId, userId, source: "web" },
        { $set: { history, updatedAt: new Date() } },
        { upsert: true }
    );
}

// ===== Clients (Message Count & Limit) =====
async function incrementMessageCount(clientId) {
  const db = await connectDB();
  const clients = db.collection("Clients");

  const updated = await clients.findOneAndUpdate(
    { clientId },
    {
      $inc: { messageCount: 1 },
      $setOnInsert: { messageLimit: 1000, active: true, quotaWarningSent: false }
    },
    { returnDocument: "after", upsert: true }
  );

  let client = updated.value;
  if (!client) client = await clients.findOne({ clientId });
  if (!client) throw new Error(`Failed to create/find client ${clientId}`);

  if (client.messageCount > client.messageLimit) {
    return { allowed: false, messageCount: client.messageCount, messageLimit: client.messageLimit };
  }

  const remaining = client.messageLimit - client.messageCount;
  if (remaining === 100 && !client.quotaWarningSent) {
    await sendQuotaWarning(clientId);
    await clients.updateOne({ clientId }, { $set: { quotaWarningSent: true } });
  }

  return { allowed: true, messageCount: client.messageCount, messageLimit: client.messageLimit };
}

// ===== Image helper =====
// Formats user message and image for OpenAI Vision API
// Handles base64 images from frontend and converts them to proper format
async function formatMessageForGPT(userMessage, image) {
    const contentPayload = [];
    
    // Add text message if provided
    if (userMessage && typeof userMessage === "string" && userMessage.trim()) {
        contentPayload.push({ type: "text", text: userMessage });
    }

    // Handle image: convert base64 to OpenAI-compatible format
    if (image && typeof image === "string" && image.trim()) {
        try {
            let imageUrl = image;
            
            // If image is base64 without data URL prefix, add it
            // OpenAI expects: data:image/<format>;base64,<base64_string>
            if (!image.startsWith("data:")) {
                // Try to detect image format from base64 or default to jpeg
                // Most common formats: jpeg, png, gif, webp
                let mimeType = "image/jpeg"; // default
                
                // Check if it's a valid base64 string
                const base64Pattern = /^[A-Za-z0-9+/=]+$/;
                if (base64Pattern.test(image.replace(/\s/g, ""))) {
                    imageUrl = `data:${mimeType};base64,${image}`;
                } else {
                    // If already a data URL, use as is
                    imageUrl = image;
                }
            }
            
            // Add image to content payload for OpenAI Vision API
            contentPayload.push({ 
                type: "image_url", 
                image_url: {
                    url: imageUrl,
                    detail: "auto" // "auto" balances speed and accuracy
                }
            });
        } catch (err) {
            console.error("❌ Error formatting image:", err.message);
            // Continue without image if formatting fails
        }
    }

    // Ensure at least one content item (text or image)
    if (contentPayload.length === 0) {
        contentPayload.push({ type: "text", text: "" });
    }

    return contentPayload;
}

// ===== Route =====
router.post("/", async (req, res) => {
    let { message: userMessage, clientId, userId, isFirstMessage, image } = req.body;
    if (!userId) userId = crypto.randomUUID();

    console.log("Incoming chat request:", { 
        clientId, 
        userId, 
        userMessage: userMessage ? `${userMessage.substring(0, 50)}...` : null, 
        isFirstMessage, 
        hasImage: !!image,
        imageLength: image ? image.length : 0
    });

    // Accept requests with text, image, or both - at least one must be present
    if ((!userMessage || !userMessage.trim()) && (!image || !image.trim())) {
        return res.status(400).json({ reply: "⚠️ Please provide a message or image." });
    }
    if (!clientId) return res.status(400).json({ reply: "⚠️ Missing client ID." });

    try {
        const db = await connectDB();
        const clientsCollection = db.collection("Clients");
        const clientDoc = await clientsCollection.findOne({ clientId });
        if (!clientDoc || clientDoc.active === false) return res.status(204).end();

        const usage = await incrementMessageCount(clientId);
        if (!usage.allowed) return res.json({ reply: "" });

        await findOrCreateCustomer(userId, clientId);

        // Detect user name
        let nameMatch = null;
        const myNameMatch = userMessage?.match(/my name is\s+(.+)/i);
        const bracketNameMatch = userMessage?.match(/\[name\]\s*:\s*(.+)/i);
        if (myNameMatch) nameMatch = myNameMatch[1].trim();
        if (bracketNameMatch) nameMatch = bracketNameMatch[1].trim();
        if (nameMatch) await updateCustomerName(userId, clientId, nameMatch);

        // System prompt + client files
        const finalSystemPrompt = await SYSTEM_PROMPT({ clientId });
        let filesContent = "";
        if (clientDoc?.files?.length) {
            filesContent = clientDoc.files.map(f => `File: ${f.name}\nContent:\n${f.content}`).join("\n\n");
        }

        // Conversation history
        let convo = await getConversation(clientId, userId);
        let greeting = "";
        if (isFirstMessage) {
            const customer = await db.collection("Customers").findOne({ customerId: userId, clientId });
            if (customer?.name) greeting = `Hi ${customer.name}, welcome back! 👋\n\n`;
        }

        let history = convo?.history || [
            {
                role: "system",
                content: [{ type: "text", text: `${finalSystemPrompt}\n\nUse the following client files:\n${filesContent}` }]
            }
        ];

        // Add user message with optional image
        // formatMessageForGPT handles base64 images and converts them to OpenAI format
        let userContent;
        try {
            userContent = await formatMessageForGPT(userMessage, image);
        } catch (err) {
            console.error("❌ Error formatting message/image:", err.message);
            return res.status(400).json({ reply: "⚠️ Error processing your message or image. Please try again." });
        }
        
        // Validate that we have at least text or image content
        if (!userContent || userContent.length === 0) {
            return res.status(400).json({ reply: "⚠️ Please provide a valid message or image." });
        }
        
        history.push({ role: "user", content: userContent, createdAt: new Date() });

        // Call OpenAI with image support
        let assistantResponse;
        try {
            if (process.env.TEST_MODE === "true") {
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 300) + 100));
                assistantResponse = { text: "🧪 Mock reply (image supported)", imageUrls: [] };
            } else {
                assistantResponse = await getChatCompletion(history);
            }
        } catch (err) {
            console.error("❌ OpenAI error:", err.message);
            await db.collection("Logs").insertOne({
                clientId, userId, level: "error", source: "openai", message: err.message, timestamp: new Date(),
            });
            assistantResponse = { text: "⚠️ I'm having trouble right now.", imageUrls: [] };
        }

        // Extract text and image URLs from response
        // Handle both new format (object with text/imageUrls) and legacy format (string)
        let assistantMessage = "";
        let imageUrls = [];
        if (typeof assistantResponse === "string") {
            // Legacy format: just text
            assistantMessage = assistantResponse;
        } else if (assistantResponse && typeof assistantResponse === "object") {
            // New format: object with text and imageUrls
            assistantMessage = assistantResponse.text || "";
            imageUrls = assistantResponse.imageUrls || [];
        }

        // Save assistant reply (store text and image URLs separately for history)
        const assistantContent = [{ type: "text", text: assistantMessage }];
        if (imageUrls.length > 0) {
            // Store image URLs as text references in history
            assistantContent.push({ 
                type: "text", 
                text: `\n[Images: ${imageUrls.join(", ")}]`
            });
        }
        history.push({ role: "assistant", content: assistantContent, createdAt: new Date() });
        await saveConversation(clientId, userId, history);

        // Handle tour booking
        if (assistantMessage.includes("[TOUR_REQUEST]")) {
            const data = extractTourData(assistantMessage);
            data.clientId = clientId;
            try { await sendTourEmail(data); } catch (err) {
                console.error("❌ Failed to send tour email:", err.message);
                await db.collection("Logs").insertOne({
                    clientId, userId, level: "error", source: "email", message: err.message, timestamp: new Date(),
                });
            }
        }

        // Return response with text, image URLs (if any), and metadata
        res.json({ 
            reply: greeting + assistantMessage, 
            imageUrls: imageUrls, // Include image URLs from OpenAI response
            userId, 
            usage: { count: usage.messageCount, limit: usage.messageLimit } 
        });

    } catch (error) {
        console.error("❌ Error:", error.message);
        try {
            const db = await connectDB();
            await db.collection("Logs").insertOne({
                clientId, userId, level: "error", source: "web", message: error.message, timestamp: new Date(),
            });
        } catch (dbErr) {
            console.error("❌ Failed to log error in DB:", dbErr.message);
        }
        res.status(500).json({ reply: "⚠️ Sorry, something went wrong." });
    }
});

export default router;
