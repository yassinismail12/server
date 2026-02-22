// routes/whatsappEmbedded.js
import express from "express";
import fetch from "node-fetch";

const router = express.Router();
const API_VER = process.env.META_GRAPH_VERSION || "v25.0";

function logReq(req, label) {
  console.log(`\n🟦 [WA:${label}] ${new Date().toISOString()}`);
  console.log("method:", req.method, "url:", req.originalUrl);
  console.log("query:", req.query);
  // body logged only where relevant
}

const REDIRECT_URI = String(process.env.WHATSAPP_REDIRECT_URI || "").trim();
const CONFIG_ID = String(process.env.WP_CONFIG || "").trim();
const APP_ID = String(process.env.FACEBOOK_APP_ID || "").trim();
const APP_SECRET = String(process.env.FACEBOOK_APP_SECRET || "").trim();

// ✅ sanity endpoint (to confirm router is mounted)
router.get("/whatsapp/ping", (req, res) => {
  logReq(req, "PING");
  return res.json({ ok: true, where: "whatsappEmbedded router", t: new Date().toISOString() });
});

// 1) Dashboard reads config from here
router.get("/whatsapp/config", (req, res) => {
  logReq(req, "CONFIG");
  console.log("ENV:", {
    hasAppId: Boolean(APP_ID),
    hasAppSecret: Boolean(APP_SECRET),
    hasConfigId: Boolean(CONFIG_ID),
    redirectUri: REDIRECT_URI,
    redirectUriJSON: JSON.stringify(REDIRECT_URI),
  });

  return res.json({
    ok: true,
    configId: CONFIG_ID,
    redirectUri: REDIRECT_URI,
    apiVer: API_VER,
  });
});

// 2) Redirect URI endpoint (must EXACTLY match what you send in OAuth)
router.get("/whatsapp/embedded/redirect", (req, res) => {
  logReq(req, "REDIRECT_HIT");
  // This endpoint doesn't need to do anything; it's just to exist & be reachable.
  return res.status(200).send("OK");
});

// (Optional) A server-driven OAuth start (useful if SDK drives you crazy)
router.get("/whatsapp/embedded/start", (req, res) => {
  logReq(req, "START");
  const clientId = String(req.query.clientId || "").trim();
  if (!clientId) return res.status(400).send("Missing clientId");

  if (!APP_ID || !CONFIG_ID || !REDIRECT_URI) {
    return res.status(500).send("Missing env: FACEBOOK_APP_ID / WP_CONFIG / WHATSAPP_REDIRECT_URI");
  }

  const dialogUrl =
    `https://www.facebook.com/${API_VER}/dialog/oauth` +
    `?client_id=${encodeURIComponent(APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent("whatsapp_business_management,whatsapp_business_messaging")}` +
    `&config_id=${encodeURIComponent(CONFIG_ID)}` +
    `&state=${encodeURIComponent(clientId)}`;

  console.log("➡️ redirecting to:", dialogUrl);
  return res.redirect(dialogUrl);
});

// 3) Exchange code -> token (this is where you were failing)
router.post("/whatsapp/embedded/exchange", async (req, res) => {
  logReq(req, "EXCHANGE");
  console.log("body:", {
    hasClientId: Boolean(req.body?.clientId),
    hasCode: Boolean(req.body?.code),
    codePreview: req.body?.code ? String(req.body.code).slice(0, 12) + "..." : null,
  });

  const { clientId, code } = req.body || {};
  if (!clientId || !code) {
    console.warn("❌ Missing clientId/code");
    return res.status(400).json({ ok: false, error: "Missing clientId or code" });
  }

  if (!APP_ID || !APP_SECRET || !REDIRECT_URI) {
    console.warn("❌ Missing env", { APP_ID: !!APP_ID, APP_SECRET: !!APP_SECRET, REDIRECT_URI: !!REDIRECT_URI });
    return res.status(500).json({
      ok: false,
      error: "Missing env: FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / WHATSAPP_REDIRECT_URI",
    });
  }

  try {
    // ✅ This MUST match EXACTLY the redirect_uri used to obtain the code
    const tokenUrl =
      `https://graph.facebook.com/${API_VER}/oauth/access_token` +
      `?client_id=${encodeURIComponent(APP_ID)}` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code=${encodeURIComponent(code)}`;

    console.log("🔁 tokenUrl:", tokenUrl);

    const tokenResp = await fetch(tokenUrl);
    const tokenText = await tokenResp.text();

    let tokenJson;
    try {
      tokenJson = JSON.parse(tokenText);
    } catch {
      tokenJson = { raw: tokenText };
    }

    console.log("🔁 TOKEN EXCHANGE RESULT", {
      ok: tokenResp.ok,
      status: tokenResp.status,
      json: tokenJson,
    });

    if (!tokenResp.ok || tokenJson?.error) {
      return res.status(400).json({
        ok: false,
        step: "code_exchange",
        error: tokenJson?.error || tokenJson,
        debug: { redirectUsed: REDIRECT_URI },
      });
    }

    // ✅ If you only want to confirm it works:
    return res.json({
      ok: true,
      message: "✅ code -> token worked",
      clientId,
      tokenType: tokenJson.token_type || "unknown",
      expiresIn: tokenJson.expires_in || null,
      accessTokenPreview: tokenJson.access_token ? tokenJson.access_token.slice(0, 12) + "..." : null,
    });
  } catch (e) {
    console.error("❌ EXCHANGE CRASH", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;