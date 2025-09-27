import fetch from "node-fetch";
import { getClientCredentials } from "../utils/messengerCredentials.js";

/**
 * Send a text reply to a Messenger user
 */
export async function sendMessengerReply(sender_psid, response, pageId) {
    try {
        const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

        await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                recipient: { id: sender_psid },
                message: { text: response }
            })
        });

        console.log(`✅ Sent reply to PSID: ${sender_psid}, pageId: ${pageId}`);
    } catch (err) {
        console.error("❌ Failed to send Messenger reply:", err.message);
    }
}

/**
 * Show or hide Messenger typing indicator
 */
export async function sendTypingIndicator(sender_psid, pageId, on = true) {
    try {
        const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

        const action = on ? "typing_on" : "typing_off";
        const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                recipient: { id: sender_psid },
                sender_action: action
            })
        });

        console.log(`✍️ Sent typing indicator (${action}) for PSID: ${sender_psid}, pageId: ${pageId}`);
    } catch (err) {
        console.error("❌ Failed to send typing indicator:", err.message);
    }
}

/**
 * Setup Messenger ice breakers for a page
 */
export async function setupIceBreakers(pageId) {
    try {
        const { PAGE_ACCESS_TOKEN } = await getClientCredentials(pageId);

        const response = await fetch(
            `https://graph.facebook.com/v18.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ice_breakers: [
                        { question: "What properties are available?", payload: "ICE_BREAKER_PROPERTIES" },
                        { question: "How can I book a visit?", payload: "ICE_BREAKER_BOOK" },
                        { question: "Do you offer payment plans?", payload: "ICE_BREAKER_PAYMENT" },
                    ]
                })
            }
        );

        const data = await response.json();
        console.log("✅ Ice breakers setup result:", data);
    } catch (error) {
        console.error("❌ Error setting up ice breakers:", error.message);
    }
}
