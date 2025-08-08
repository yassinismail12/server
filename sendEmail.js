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
        to: process.env.EMAIL_TO,  // recipient email
        subject: "New Tour Request",
        text: `Tour request from ${data.name}, phone: ${data.phone}, unit type: ${data.unitType}`,
        html: `<p><strong>Tour request:</strong></p>
           <p>Name: ${data.name}</p>
           <p>Phone: ${data.phone}</p>
           <p>Unit Type: ${data.unitType}</p>`,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("Tour request email sent successfully!");
    } catch (error) {
        console.error("Error sending email:", error);
    }
}
