// sendEmail.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export async function sendTourEmail(data) {
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.EMAIL_USER,   // your Gmail address
            pass: process.env.EMAIL_PASS,   // your Gmail App password
        },
    });

    const mailOptions = {
        from: `"Real Estate Agent" <${process.env.EMAIL_USER}>`,
        to: "yassinismail623@gmail.com",
        subject: "New Tour Request",
        text: `Tour request Interested:\nName: ${data.name}\nPhone: ${data.phone}\nEmail: ${data.email}\nDate: ${data.date}\nUnit Type: ${data.unitType}`

        // no html field
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("Tour request email sent successfully!");
    } catch (error) {
        console.error("Error sending email:", error);
    }
}
