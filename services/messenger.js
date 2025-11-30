import fetch from "node-fetch";
import { getClientCredentials } from "../utils/messengerCredentials.js";
import { connectToDB } from "./db.js";

const GRAPH_VERSION = "v23.0";

/**
 * Send a text reply to a Messenger user
 */
export async function sendMessengerReply(sender_psid, response, pageId) {
  try {
    const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: sender_psid },
        message: { text: response },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("❌ Messenger reply failed:", data);
    } else {
      console.log(`✅ Sent reply to PSID: ${sender_psid}, pageId: ${pageId}`);
    }
  } catch (err) {
    console.error("❌ Failed to send Messenger reply:", err.message);
  }
}

/**
 * Send "mark_seen" to acknowledge the user's message
 * (Replaces typing indicator until it's stable)
 */
export async function sendMarkAsRead(psid, pageId) {
  try {
    const db = await connectToDB();
    const client = await db.collection("Clients").findOne({ pageId });

    if (!client || !client.PAGE_ACCESS_TOKEN) {
      console.error("❌ Missing PAGE_ACCESS_TOKEN for pageId:", pageId);
      return;
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${client.PAGE_ACCESS_TOKEN}`;

    const body = {
      recipient: { id: psid },
      sender_action: "mark_seen",
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("❌ Mark as read failed:", data);
    } else {
      console.log(`👁️ Marked message as read for ${psid}`);
    }
  } catch (err) {
    console.error("❌ Mark as read error:", err.message);
  }
}

/**
 * Send reply with "mark_seen" delay (helper)
 * → Shows 'seen' confirmation before sending message
 */
export async function sendWithMarkSeen(sender_psid, pageId, response, delayMs = 2000) {
  await sendMarkAsRead(sender_psid, pageId);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await sendMessengerReply(sender_psid, response, pageId);
}

/**
 * Setup Messenger ice breakers for a page
 */
export async function setupIceBreakers(pageId) {
  try {
    const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ice_breakers: [
          { question: "What properties are available?", payload: "ICE_BREAKER_PROPERTIES" },
          { question: "How can I book a visit?", payload: "ICE_BREAKER_BOOK" },
          { question: "Do you offer payment plans?", payload: "ICE_BREAKER_PAYMENT" },
        ],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("❌ Ice breakers setup failed:", data);
    } else {
      console.log("✅ Ice breakers setup result:", data);
    }
  } catch (error) {
    console.error("❌ Error setting up ice breakers:", error.message);
  }
}