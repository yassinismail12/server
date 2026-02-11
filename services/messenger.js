// services/messenger.js
import fetch from "node-fetch";
import { getClientCredentials } from "../utils/messengerCredentials.js";

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v23.0";

function normalizeId(x) {
  return String(x || "").trim();
}

function normalizeText(x) {
  return String(x || "").trim();
}

async function postToMessenger(pageAccessToken, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${pageAccessToken}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Send a text reply to a Messenger user
 * Supports:
 *  - sendMessengerReply(sender_psid, response, pageId)
 *  - sendMessengerReply({ psid, text, pageId })
 */
export async function sendMessengerReply(a, b, c) {
  let psid, text, pageId;

  if (typeof a === "object" && a) {
    psid = a.psid;
    text = a.text;
    pageId = a.pageId;
  } else {
    psid = a;
    text = b;
    pageId = c;
  }

  psid = normalizeId(psid);
  pageId = normalizeId(pageId);
  text = normalizeText(text);

  if (!psid || !pageId || !text) {
    console.error("❌ sendMessengerReply missing fields", { psid: !!psid, pageId: !!pageId, text: !!text });
    return { ok: false, error: "missing_fields" };
  }

  try {
    const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

    if (!PAGE_ACCESS_TOKEN) {
      console.error("❌ Missing PAGE_ACCESS_TOKEN for pageId:", pageId);
      return { ok: false, error: "missing_page_access_token" };
    }

    const body = {
      recipient: { id: psid },
      message: { text },
    };

    const result = await postToMessenger(PAGE_ACCESS_TOKEN, body);

    if (!result.ok) {
      console.error("❌ Messenger reply failed:", result.data);
      return { ok: false, status: result.status, data: result.data };
    }

    console.log(`✅ Sent reply to PSID: ${psid}, pageId: ${pageId}`);
    return { ok: true, data: result.data };
  } catch (err) {
    console.error("❌ Failed to send Messenger reply:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Send "mark_seen" to acknowledge the user's message
 * Supports:
 *  - sendMarkAsRead(psid, pageId)
 *  - sendMarkAsRead({ psid, pageId })
 */
export async function sendMarkAsRead(a, b) {
  let psid, pageId;

  if (typeof a === "object" && a) {
    psid = a.psid;
    pageId = a.pageId;
  } else {
    psid = a;
    pageId = b;
  }

  psid = normalizeId(psid);
  pageId = normalizeId(pageId);

  if (!psid || !pageId) {
    console.error("❌ sendMarkAsRead missing fields", { psid: !!psid, pageId: !!pageId });
    return { ok: false, error: "missing_fields" };
  }

  try {
    const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

    if (!PAGE_ACCESS_TOKEN) {
      console.error("❌ Missing PAGE_ACCESS_TOKEN for pageId:", pageId);
      return { ok: false, error: "missing_page_access_token" };
    }

    const body = {
      recipient: { id: psid },
      sender_action: "mark_seen",
    };

    const result = await postToMessenger(PAGE_ACCESS_TOKEN, body);

    if (!result.ok) {
      console.error("❌ Mark as read failed:", result.data);
      return { ok: false, status: result.status, data: result.data };
    }

    console.log(`👁️ Marked message as read for ${psid}, pageId: ${pageId}`);
    return { ok: true, data: result.data };
  } catch (err) {
    console.error("❌ Mark as read error:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Send reply with "mark_seen" delay (helper)
 */
export async function sendWithMarkSeen(sender_psid, pageId, response, delayMs = 2000) {
  await sendMarkAsRead(sender_psid, pageId);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return await sendMessengerReply(sender_psid, response, pageId);
}

/**
 * Setup Messenger ice breakers for a page
 */
export async function setupIceBreakers(pageId) {
  pageId = normalizeId(pageId);

  try {
    const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

    if (!PAGE_ACCESS_TOKEN) {
      console.error("❌ Missing PAGE_ACCESS_TOKEN for pageId:", pageId);
      return { ok: false, error: "missing_page_access_token" };
    }

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

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("❌ Ice breakers setup failed:", data);
      return { ok: false, status: res.status, data };
    }

    console.log("✅ Ice breakers setup result:", data);
    return { ok: true, data };
  } catch (error) {
    console.error("❌ Error setting up ice breakers:", error.message);
    return { ok: false, error: error.message };
  }
}
