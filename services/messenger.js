import fetch from "node-fetch";

export async function sendMessengerReply(sender_psid, response) {
    const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

    await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            recipient: { id: sender_psid },
            message: { text: response }
        })
    });
}

export async function setupIceBreakers() {
    const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

    try {
        const response = await fetch(`https://graph.facebook.com/v18.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ice_breakers: [
                    {
                        question: "What properties are available?",
                        payload: "ICE_BREAKER_PROPERTIES"
                    },
                    {
                        question: "How can I book a visit?",
                        payload: "ICE_BREAKER_BOOK"
                    },
                    {
                        question: "Do you offer payment plans?",
                        payload: "ICE_BREAKER_PAYMENT"
                    }
                ]
            })
        });

        const data = await response.json();
        console.log("✅ Ice breakers setup result:", data);
    } catch (error) {
        console.error("❌ Error setting up ice breakers:", error.message);
    }
}
