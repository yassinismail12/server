import express from "express";
import Order from "../order.js";
import { notifyClientStaffNewOrder } from "../utils/notifyClientStaffWhatsApp.js";

const router = express.Router();

// Minimal validation helper
function requireStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`Missing ${name}`);
  return s;
}

router.post("/orders", async (req, res) => {
  try {
    const clientId = requireStr(req.body.clientId, "clientId");
    const channel = requireStr(req.body.channel, "channel"); // messenger | instagram | web

    const customerName = String(req.body.customerName || "").trim();
    const customerPhone = String(req.body.customerPhone || "").trim();
    const externalUserId = String(req.body.externalUserId || "").trim();

    const itemsText = String(req.body.itemsText || "").trim();
    const notes = String(req.body.notes || "").trim();

    // 1) Save order
    const order = await Order.create({
      clientId,
      channel,
      customer: { name: customerName, phone: customerPhone, externalUserId },
      itemsText,
      notes,
      status: "new",
    });

    // 2) Notify staff on WhatsApp (template)
    const notifyResult = await notifyClientStaffNewOrder({
      clientId,
      payload: {
        customerName,
        customerPhone,
        itemsText,
        notes,
        orderId: String(order._id),
      },
    });

    return res.status(201).json({
      ok: true,
      orderId: order._id,
      notifyResult,
    });
  } catch (e) {
    console.error("Create order failed:", e);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
