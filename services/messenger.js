import fetch from "node-fetch";
import { getClientCredentials } from "./utils/messengerCredentials.js";

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
    } catch (err) {
        console.error("❌ Failed to send Messenger reply:", err.message);
    }
}



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

