import express from "express";
import Client from "../Client.js"; // adjust path/name to your real Client model

const router = express.Router();

async function getPageTokenForClient(clientId, pageId) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error("Client not found");

  // ✅ adjust these fields to match your DB
  const token = client.PAGE_ACCESS_TOKEN || client.pageAccessToken || client.pageToken;
  const storedPageId = client.pageId;

  if (!token) throw new Error("No Page access token stored for this client");
  if (storedPageId && String(storedPageId) !== String(pageId)) {
    throw new Error("PageId mismatch: this client is not connected to that Page");
  }
  return token;
}

// ✅ GET recent Page posts (needs pages_read_engagement)
router.get("/pages/:pageId/posts", async (req, res) => {
  try {
    const { pageId } = req.params;
    const clientId = req.user?.clientId || req.query.clientId; // use your auth method

    if (!clientId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const token = await getPageTokenForClient(clientId, pageId);

    const url =
      `https://graph.facebook.com/v20.0/${pageId}/feed` +
      `?fields=message,created_time,permalink_url` +
      `&limit=5` +
      `&access_token=${encodeURIComponent(token)}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) return res.status(r.status).json({ ok: false, error: data });
    res.json({ ok: true, data: data.data || [] });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ✅ GET comments for a post (needs pages_read_engagement)
router.get("/posts/:postId/comments", async (req, res) => {
  try {
    const { postId } = req.params;
    const { pageId } = req.query;
    const clientId = req.user?.clientId || req.query.clientId;

    if (!clientId) return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (!pageId) return res.status(400).json({ ok: false, error: "Missing pageId" });

    const token = await getPageTokenForClient(clientId, pageId);

    const url =
      `https://graph.facebook.com/v20.0/${postId}/comments` +
      `?fields=from{name,id},message,created_time` +
      `&limit=10` +
      `&access_token=${encodeURIComponent(token)}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) return res.status(r.status).json({ ok: false, error: data });
    res.json({ ok: true, data: data.data || [] });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
