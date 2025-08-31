// sendEmail.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import Client from "./Client.js";

dotenv.config();

export async function sendTourEmail(data) {
    try {
        // Fetch the client email from MongoDB using clientId from data
        if (!data.clientId) {
            throw new Error("clientId is required in data to fetch email");
        }

        const client = await Client.findOne({ clientId: data.clientId }).lean();
        if (!client || !client.email) {
            throw new Error("Client email not found");
        }

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const mailOptions = {
            from: `"Real Estate Agent" <${process.env.EMAIL_USER}>`,
            to: client.email, // ✅ dynamic email from MongoDB
            subject: "New Tour Request",
            text: `Tour request Interested:\nName: ${data.name}\nPhone: ${data.phone}\nEmail: ${data.email}\nDate: ${data.date}\nUnit Type: ${data.unitType}`
        };

        await transporter.sendMail(mailOptions);
        console.log(`Tour request email sent successfully to ${client.email}!`);
    } catch (error) {
        console.error("Error sending email:", error.message);
    }
}
