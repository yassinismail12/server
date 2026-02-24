// utils/systemPrompt.js
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const mongo = new MongoClient(uri);
const dbName = "Agent";

async function getClientsCol() {
  if (!mongo.topology || !mongo.topology.isConnected()) {
    await mongo.connect();
  }
  return mongo.db(dbName).collection("Clients");
}

/**
 * Returns ONLY the system rules / persona prompt for the client.
 * ❌ Does NOT append full files (KB) — KB must come from retrieval chunks.
 *
 * Accepts one of: clientId, pageId, igId
 */
export async function SYSTEM_PROMPT({ clientId, pageId, igId } = {}) {
  const clients = await getClientsCol();

  // ✅ FIX: priority order must be explicit (not else-if chain that blocks)
  const query =
    pageId ? { pageId: String(pageId) } :
    igId ? { igId: String(igId) } :
    clientId ? { clientId: String(clientId) } :
    null;

  if (!query) throw new Error("Missing identifier: clientId/pageId/igId");

  const clientData = await clients.findOne(query);
  if (!clientData) throw new Error("Client not found");

  let finalPrompt = String(clientData.systemPrompt || "").trim();

  // ✅ Optional: safe placeholders replace (ONLY from known safe string fields)
  // (prevents accidentally injecting huge strings or objects)
  const safeReplacements = {
    name: clientData.name || "",
    email: clientData.email || "",
    clientId: clientData.clientId || "",
    PAGE_NAME: clientData.PAGE_NAME || "",
    igUsername: clientData.igUsername || "",
    whatsappDisplayPhone: clientData.whatsappDisplayPhone || "",
  };

  for (const [key, value] of Object.entries(safeReplacements)) {
    finalPrompt = finalPrompt.replaceAll(`{{${key}}}`, String(value));
  }

  // ✅ If empty, provide a minimal default system prompt
  if (!finalPrompt) {
    finalPrompt =
      `You are a helpful business assistant.\n` +
      `Answer based only on the provided business data.\n` +
      `If you don't know, say you don't know and ask a short follow-up question.\n`;
  }

  return finalPrompt;
}