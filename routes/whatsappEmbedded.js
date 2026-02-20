// routes/whatsappEmbedded.js
import express from "express";
import fetch from "node-fetch";
import Client from "../Client.js";

const router = express.Router();

const API_VER = process.env.META_GRAPH_VERSION || "v25.0";

// 1) Dashboard reads config_id from here
router.get("/api/whatsapp/config", (req, res) => {
  return res.json({ ok: true, configId: process.env.WP_CONFIG || "" });
});

// 2) Redirect URI endpoint (must match Meta Valid OAuth Redirect URIs exactly)
router.get("/api/whatsapp/embedded/redirect", (req, res) => {
  res.status(200).send("OK");
});

// Helper: exchange short-lived token -> long-lived token (recommended)
async function exchangeToLongLivedToken({ appId, appSecret, shortToken }) {
  const url =
    `https://graph.facebook.com/${API_VER}/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(shortToken)}`;

  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok || j?.error) throw new Error(`Long-lived token exchange failed: ${JSON.stringify(j)}`);
  return { access_token: j.access_token, expires_in: j.expires_in };
}

// 3) Exchange code -> token -> fetch WABA + phone_number_id -> save to Client
router.post("/api/whatsapp/embedded/exchange", async (req, res) => {
  const { clientId, code } = req.body;
  if (!clientId || !code) return res.status(400).json({ ok: false, error: "Missing clientId or code" });

  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.WHATSAPP_REDIRECT_URI;

    if (!appId || !appSecret || !redirectUri) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars: FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / FACEBOOK_REDIRECT_URI",
      });
    }

    // A) code -> short-lived token
    const tokenUrl =
      `https://graph.facebook.com/${API_VER}/oauth/access_token` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenResp = await fetch(tokenUrl);
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || tokenJson?.error) {
      return res.status(400).json({ ok: false, error: tokenJson?.error || tokenJson });
    }

    const shortToken = tokenJson.access_token;

    // B) short -> long-lived token (so it doesn't die quickly)
    let finalToken = shortToken;
    let expiresIn = null;

    try {
      const ll = await exchangeToLongLivedToken({ appId, appSecret, shortToken });
      finalToken = ll.access_token;
      expiresIn = ll.expires_in; // seconds (typically ~60 days)
    } catch (e) {
      // If this fails, still proceed with short token (MVP), but you’ll see it in logs.
      console.warn("⚠️ Long-lived exchange failed, using short token:", e.message);
    }

    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    // C) get user id
    const meResp = await fetch(`https://graph.facebook.com/${API_VER}/me?access_token=${encodeURIComponent(finalToken)}`);
    const meJson = await meResp.json();
    if (!meResp.ok || meJson?.error || !meJson?.id) {
      return res.status(400).json({ ok: false, error: meJson?.error || meJson });
    }
    const userId = meJson.id;

    // D) get WABA
    const wabaResp = await fetch(
      `https://graph.facebook.com/${API_VER}/${userId}/whatsapp_business_accounts?access_token=${encodeURIComponent(finalToken)}`
    );
    const wabaJson = await wabaResp.json();
    const wabaId = wabaJson?.data?.[0]?.id;

    if (!wabaResp.ok || wabaJson?.error || !wabaId) {
      return res.status(400).json({ ok: false, error: wabaJson?.error || wabaJson || "No WABA found" });
    }

    // E) get phone numbers
    const phoneResp = await fetch(
      `https://graph.facebook.com/${API_VER}/${wabaId}/phone_numbers?access_token=${encodeURIComponent(finalToken)}`
    );
    const phoneJson = await phoneResp.json();
    const phoneNumberId = phoneJson?.data?.[0]?.id;
    const displayPhone = phoneJson?.data?.[0]?.display_phone_number || "";

    if (!phoneResp.ok || phoneJson?.error || !phoneNumberId) {
      return res.status(400).json({ ok: false, error: phoneJson?.error || phoneJson || "No phone number found" });
    }

    // F) Save to your REAL schema fields
    await Client.updateOne(
      { clientId },
      {
        $set: {
          whatsappWabaId: wabaId,
          whatsappPhoneNumberId: String(phoneNumberId),
          whatsappDisplayPhone: displayPhone,
          whatsappAccessToken: finalToken,
          whatsappConnectedAt: new Date(),
          whatsappTokenType: expiresIn ? "user_long_lived" : "user_short_lived",
          whatsappTokenExpiresAt: expiresAt,
        },
      }
    );

    return res.json({
      ok: true,
      wabaId,
      phoneNumberId,
      displayPhone,
      tokenType: expiresIn ? "user_long_lived" : "user_short_lived",
      expiresAt,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// 4) Status endpoint for dashboard
router.get("/api/whatsapp/status", async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ ok: false, error: "Missing clientId" });

  const c = await Client.findOne({ clientId }).lean();
  if (!c) return res.status(404).json({ ok: false, error: "Client not found" });

  return res.json({
    ok: true,
    connected: Boolean(c.whatsappWabaId && c.whatsappPhoneNumberId && c.whatsappAccessToken),
    wabaId: c.whatsappWabaId || "",
    phoneNumberId: c.whatsappPhoneNumberId || "",
    displayPhone: c.whatsappDisplayPhone || "",
    tokenType: c.whatsappTokenType || "",
    tokenExpiresAt: c.whatsappTokenExpiresAt || null,
  });
});

export default router;