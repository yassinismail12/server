// sendQuotaWarning.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import Client from "./Client.js"; // import your Client model

dotenv.config();

export async function sendQuotaWarning(clientId) {
    try {
        // 1️⃣ fetch client email from MongoDB
        const client = await Client.findOne({ clientId }).lean();
        if (!client || !client.email) {
            throw new Error("Client email not found");
        }

        // 2️⃣ create transporter
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        // 3️⃣ email content
        const mailOptions = {
            from: `"Agent Bot Alerts" <${process.env.EMAIL_USER}>`,
            to: client.email, // ✅ dynamic client email
            subject: "⚠️ Quota Warning: Only 100 Messages Left",
            text: `Hello ${client.name || "Client"},\n\nYou have only 100 messages left in your quota. 
Please consider upgrading your plan soon to avoid interruptions.\n\n- Agent Bot`,
        };

        await transporter.sendMail(mailOptions);
        console.log(`⚠️ Quota warning email sent successfully to ${client.email}!`);
    } catch (error) {
        console.error("Error sending quota warning email:", error.message);
    }
}
