// routes/whatsappEmbedded.js (MINIMAL)
import express from "express";
import fetch from "node-fetch";

const router = express.Router();
const API_VER = process.env.META_GRAPH_VERSION || "v25.0";

// your exact redirect (must be added in Meta "Valid OAuth Redirect URIs")
const REDIRECT_URI = String(process.env.WHATSAPP_REDIRECT_URI || "").trim();

router.get("/api/whatsapp/config", (req, res) => {
  return res.json({ ok: true, configId: String(process.env.WP_CONFIG || "").trim(), redirectUri: REDIRECT_URI });
});

// STEP A: start OAuth (redirect user to Meta)
router.get("/api/whatsapp/embedded/start", (req, res) => {
  const clientId = String(req.query.clientId || "").trim();
  if (!clientId) return res.status(400).send("Missing clientId");

  const appId = String(process.env.FACEBOOK_APP_ID || "").trim();
  const configId = String(process.env.WP_CONFIG || "").trim();

  if (!appId || !configId || !REDIRECT_URI) {
    return res.status(500).send("Missing env: FACEBOOK_APP_ID / WP_CONFIG / WHATSAPP_REDIRECT_URI");
  }

  const dialogUrl =
    `https://www.facebook.com/${API_VER}/dialog/oauth` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent("whatsapp_business_management,whatsapp_business_messaging")}` +
    `&config_id=${encodeURIComponent(configId)}` +
    `&state=${encodeURIComponent(clientId)}`; // minimal: just pass clientId

  return res.redirect(dialogUrl);
});

// STEP B: callback (Meta redirects here with ?code=...)
router.get("/api/whatsapp/embedded/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const clientId = String(req.query.state || ""); // we used state=clientId
  if (!code) return res.status(400).send("Missing code");
  if (!clientId) return res.status(400).send("Missing clientId(state)");

  const appId = String(process.env.FACEBOOK_APP_ID || "").trim();
  const appSecret = String(process.env.FACEBOOK_APP_SECRET || "").trim();

  if (!appId || !appSecret || !REDIRECT_URI) {
    return res.status(500).send("Missing env: FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / WHATSAPP_REDIRECT_URI");
  }

  const tokenUrl =
    `https://graph.facebook.com/${API_VER}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code=${encodeURIComponent(code)}`;

  const tokenResp = await fetch(tokenUrl);
  const tokenJson = await tokenResp.json();

  if (!tokenResp.ok || tokenJson?.error) {
    console.log("TOKEN EXCHANGE FAIL:", tokenJson);
    return res.status(400).send(JSON.stringify(tokenJson?.error || tokenJson));
  }

  // If you just want to confirm it's working:
  return res.status(200).send(`OK ✅ code->token worked for clientId=${clientId}`);
});

export default router;