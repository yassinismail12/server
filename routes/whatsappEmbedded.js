// routes/whatsappEmbedded.js
import express from "express";
import fetch from "node-fetch";
import Client from "../Client.js"; // adjust path if needed

const router = express.Router();

/**
 * Frontend uses this to get WP_CONFIG without hardcoding it in React.
 */
router.get("/api/whatsapp/config", (req, res) => {
  return res.json({ ok: true, configId: process.env.WP_CONFIG });
});

/**
 * Meta requires the redirect_uri used in code exchange to match EXACTLY.
 * Add this URL in Meta -> Facebook Login -> Valid OAuth Redirect URIs
 * Example: https://serverowned.onrender.com/api/whatsapp/embedded/redirect
 */
router.get("/api/whatsapp/embedded/redirect", (req, res) => {
  // You don't need to do anything here for the popup flow; it's just a required endpoint.
  res.status(200).send("OK");
});

/**
 * Receives { clientId, code } from frontend
 * Exchanges code -> user access token
 * Fetches WABA + phone_number_id
 * Saves to Client
 */
router.post("/api/whatsapp/embedded/exchange", async (req, res) => {
  const { clientId, code } = req.body;
  if (!clientId || !code) return res.status(400).json({ ok: false, error: "Missing clientId or code" });

  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.FACEBOOK_REDIRECT_URI;

    if (!appId || !appSecret || !redirectUri) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars: FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / FACEBOOK_REDIRECT_URI",
      });
    }

    // 1) Exchange code -> access_token
    const tokenUrl =
      `https://graph.facebook.com/v25.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenResp = await fetch(tokenUrl);
    const tokenJson = await tokenResp.json();

    if (!tokenResp.ok || tokenJson?.error) {
      return res.status(400).json({ ok: false, error: tokenJson?.error || tokenJson });
    }

    const userAccessToken = tokenJson.access_token;

    // 2) Get the user id ("me")
    const meResp = await fetch(`https://graph.facebook.com/v25.0/me?access_token=${encodeURIComponent(userAccessToken)}`);
    const meJson = await meResp.json();

    if (!meResp.ok || meJson?.error || !meJson?.id) {
      return res.status(400).json({ ok: false, error: meJson?.error || meJson });
    }

    const userId = meJson.id;

    // 3) Fetch WABA(s) available
    const wabaResp = await fetch(
      `https://graph.facebook.com/v25.0/${userId}/whatsapp_business_accounts?access_token=${encodeURIComponent(userAccessToken)}`
    );
    const wabaJson = await wabaResp.json();
    const wabaId = wabaJson?.data?.[0]?.id;

    if (!wabaResp.ok || wabaJson?.error || !wabaId) {
      return res.status(400).json({ ok: false, error: wabaJson?.error || wabaJson || "No WABA found" });
    }

    // 4) Fetch phone numbers on that WABA
    const phoneResp = await fetch(
      `https://graph.facebook.com/v25.0/${wabaId}/phone_numbers?access_token=${encodeURIComponent(userAccessToken)}`
    );
    const phoneJson = await phoneResp.json();
    const phoneNumberId = phoneJson?.data?.[0]?.id;
    const displayPhone = phoneJson?.data?.[0]?.display_phone_number;

    if (!phoneResp.ok || phoneJson?.error || !phoneNumberId) {
      return res.status(400).json({ ok: false, error: phoneJson?.error || phoneJson || "No phone number found" });
    }

    // 5) Save in Client
    // You said you already have phoneNumberId in Client.js.
    // We'll set both generic and wa-prefixed fields (safe), then you can remove what you don't need.
    await Client.updateOne(
      { clientId },
      {
        $set: {
          waWabaId: wabaId,
          waPhoneNumberId: phoneNumberId,
          waDisplayPhone: displayPhone || "",
          waAccessToken: userAccessToken, // MVP
          waConnectedAt: new Date(),

          // if you already have these fields and want them filled too:
          phoneNumberId: phoneNumberId,
        },
      }
    );

    return res.json({ ok: true, wabaId, phoneNumberId, displayPhone });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Lets the dashboard show "Connected" status
 */
router.get("/api/whatsapp/status", async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

  const c = await Client.findOne({ clientId }).lean();
  if (!c) return res.status(404).json({ ok: false, error: "Client not found" });

  const wabaId = c.waWabaId || "";
  const phoneNumberId = c.waPhoneNumberId || c.phoneNumberId || "";
  const displayPhone = c.waDisplayPhone || "";

  return res.json({
    ok: true,
    connected: Boolean(wabaId && phoneNumberId),
    wabaId,
    phoneNumberId,
    displayPhone,
  });
});

export default router;