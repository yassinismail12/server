// sendEmail.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import Client from "./Client.js"; // import your Client model

dotenv.config();

export async function sendTourEmail(clientId, data) {
    try {
        // 1. Get client from MongoDB
        const client = await Client.findById(clientId).lean();

        if (!client || !client.email) {
            throw new Error("Client email not found");
        }

        // 2. Create transporter
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,   // your Gmail address
                pass: process.env.EMAIL_PASS,   // your Gmail App password
            },
        });

        // 3. Mail options
        const mailOptions = {
            from: `"Real Estate Agent" <${process.env.EMAIL_USER}>`,
            to: client.email,  // 👈 dynamic email from MongoDB
            subject: "New Tour Request",
            text: `Tour request Interested:\n
Name: ${data.name}
Phone: ${data.phone}
Email: ${data.email}
Date: ${data.date}
Unit Type: ${data.unitType}`,
        };

        // 4. Send email
        await transporter.sendMail(mailOptions);
        console.log(`Tour request email sent to ${client.email}`);
    } catch (error) {
        console.error("Error sending email:", error.message);
    }
}
