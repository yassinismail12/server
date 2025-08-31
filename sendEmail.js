// sendEmail.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import Client from "./Client.js"; // import your Client model

dotenv.config();

export async function sendTourEmail(data) {
    try {
        // 1️⃣ fetch client email from MongoDB
        if (!data.clientId) {
            throw new Error("clientId is required in data to fetch email");
        }

        const client = await Client.findOne({ clientId: data.clientId }).lean();
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

        // 3️⃣ use the MongoDB email instead of hardcoded
        const mailOptions = {
            from: `"Real Estate Agent" <${process.env.EMAIL_USER}>`,
            to: client.email, // ✅ dynamic email
            subject: "New Tour Request",
            text: `Tour request Interested:\nName: ${data.name}\nPhone: ${data.phone}\nEmail: ${data.email}\nDate: ${data.date}\nUnit Type: ${data.unitType}`
        };

        await transporter.sendMail(mailOptions);
        console.log(`Tour request email sent successfully to ${client.email}!`);
    } catch (error) {
        console.error("Error sending email:", error.message);
    }
}
