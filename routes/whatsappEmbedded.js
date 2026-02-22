// routes/whatsappEmbedded.js
import express from "express";
import fetch from "node-fetch";
import Client from "../Client.js";

const router = express.Router();

const API_VER = process.env.META_GRAPH_VERSION || "v25.0";

// 1) Dashboard reads config_id from here
router.get("/api/whatsapp/config", (req, res) => {
  return res.json({
    ok: true,
    configId: String(process.env.WP_CONFIG || "").trim(),
    redirectUri: String(process.env.WHATSAPP_REDIRECT_URI || "").trim(),
  });
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

  console.log("✅ WA EXCHANGE HIT", {
    hasClientId: Boolean(clientId),
    hasCode: Boolean(code),
    codePreview: code ? String(code).slice(0, 12) + "..." : null,
  });

  if (!clientId || !code) {
    console.warn("❌ Missing clientId/code", { body: req.body });
    return res.status(400).json({ ok: false, error: "Missing clientId or code" });
  }

  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
   const redirectUri = String(process.env.WHATSAPP_REDIRECT_URI || "").trim();

console.log("ℹ️ ENV CHECK", {
  hasAppId: Boolean(appId),
  hasAppSecret: Boolean(appSecret),
  redirectUri,
  redirectUriLen: redirectUri.length,
  redirectUriJSON: JSON.stringify(redirectUri), // ✅ shows \n, spaces, etc
});

    if (!appId || !appSecret || !redirectUri) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars: FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / WHATSAPP_REDIRECT_URI",
      });
    }

    const tokenUrl =
      `https://graph.facebook.com/${API_VER}/oauth/access_token` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenResp = await fetch(tokenUrl);
    const tokenText = await tokenResp.text(); // <-- read raw text
    let tokenJson;
    try { tokenJson = JSON.parse(tokenText); } catch { tokenJson = { raw: tokenText }; }

    console.log("🔁 TOKEN EXCHANGE RESPONSE", {
      ok: tokenResp.ok,
      status: tokenResp.status,
      json: tokenJson,
    });

    if (!tokenResp.ok || tokenJson?.error) {
      return res.status(400).json({ ok: false, step: "code_exchange", error: tokenJson?.error || tokenJson });
    }

    const userAccessToken = tokenJson.access_token;

    // ... continue your flow exactly as before ...
    // IMPORTANT: also log wabaJson and phoneJson the same way if they fail.
  } catch (e) {
    console.error("❌ WA EXCHANGE CRASH", e);
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