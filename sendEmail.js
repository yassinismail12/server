// sendEmail.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import Client from "./Client.js"; // import your Client model

dotenv.config();

export async function sendTourEmail(clientId, data) {
    try {
        // 👇 fetch client from MongoDB
        const client = await Client.findOne({ clientId }).lean();

        if (!client || !client.email) {
            throw new Error("Client email not found");
        }

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,   // your Gmail address
                pass: process.env.EMAIL_PASS,   // your Gmail App password
            },
        });

        const mailOptions = {
            from: `"Real Estate Agent" <${process.env.EMAIL_USER}>`,
            to: client.email, // 👈 use client’s email
            subject: "New Tour Request",
            text: `Tour request Interested:\nName: ${data.name}\nPhone: ${data.phone}\nEmail: ${data.email}\nDate: ${data.date}\nUnit Type: ${data.unitType}`
        };

        await transporter.sendMail(mailOptions);
        console.log(`Tour request email sent successfully to ${client.email}!`);
    } catch (error) {
        console.error("Error sending email:", error);
    }
}
