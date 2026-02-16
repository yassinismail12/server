// routes/engagement.js
import express from "express";
import fetch from "node-fetch";
import Client from "../Client.js";

const router = express.Router();

/**
 * Validate a Meta Page access token quickly.
 * Most Page tokens start with "EA" (not guaranteed, but a good sanity check).
 */
function isLikelyMetaToken(token) {
  if (!token || typeof token !== "string") return false;
  if (token.length < 20) return false;
  return true;
}

/**
 * Load client + validate that the requested pageId matches the client's connected pageId.
 * Also ensures we are using the correct token field.
 */
async function getClientAndToken(clientId, pageId) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) throw new Error("Client not found");

  const storedPageId = client.pageId;
  if (storedPageId && String(storedPageId) !== String(pageId)) {
    throw new Error("PageId mismatch: this client is not connected to that Page");
  }

  // ✅ IMPORTANT: use the real stored field only
  const token = client.PAGE_ACCESS_TOKEN;

  if (!token) throw new Error("No PAGE_ACCESS_TOKEN stored for this client");
  if (!isLikelyMetaToken(token)) throw new Error("Stored PAGE_ACCESS_TOKEN looks invalid");

  return { client, token };
}

/**
 * Helper: call Graph API and return parsed JSON with status.
 */
async function graphGet(url) {
  const r = await fetch(url);
  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { ok: r.ok, status: r.status, data };
}

/**
 * ✅ GET recent Page posts or feed
 * Query:
 *  - source=posts (default) -> /{pageId}/posts
 *  - source=feed  -> /{pageId}/feed  (often better for "timeline posts")
 */
router.get("/pages/:pageId/posts", async (req, res) => {
  try {
    const { pageId } = req.params;

    // req.user is set by verifyToken middleware if you mounted it correctly
    const clientId = req.user?.clientId || req.query.clientId;
    if (!clientId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { token } = await getClientAndToken(clientId, pageId);

    const source = (req.query.source || "posts").toLowerCase();
    const edge = source === "feed" ? "feed" : "posts";

    // Add type/status_type so you can pick a "normal" post for comments during review
    const fields = "id,message,created_time,permalink_url,type,status_type";

    const url =
      `https://graph.facebook.com/v20.0/${pageId}/${edge}` +
      `?fields=${encodeURIComponent(fields)}` +
      `&limit=5` +
      `&access_token=${encodeURIComponent(token)}`;

    const result = await graphGet(url);

    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        error: result.data,
        meta: { edge, pageId, source },
      });
    }

    return res.json({
      ok: true,
      data: result.data?.data || [],
      meta: { edge, pageId, source },
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * ✅ GET comments for a post
 * Requires: pages_read_engagement on the Page token, AND the post must be comment-readable.
 *
 * Query:
 *  - pageId is required so we can validate ownership and load the right token
 */
router.get("/posts/:postId/comments", async (req, res) => {
  try {
    const { postId } = req.params;
    const { pageId } = req.query;

    const clientId = req.user?.clientId || req.query.clientId;

    if (!clientId) return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (!pageId) return res.status(400).json({ ok: false, error: "Missing pageId" });

    const { token } = await getClientAndToken(clientId, pageId);

    const fields = "id,from{name,id},message,created_time";
    const url =
      `https://graph.facebook.com/v20.0/${postId}/comments` +
      `?fields=${encodeURIComponent(fields)}` +
      `&limit=10` +
      `&access_token=${encodeURIComponent(token)}`;

    const result = await graphGet(url);

    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        error: result.data,
        meta: { postId, pageId },
      });
    }

    return res.json({
      ok: true,
      data: result.data?.data || [],
      meta: { postId, pageId },
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
