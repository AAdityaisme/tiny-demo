/**
 * POST /api/match {url}: read a Shopify store and return its profile with rule-based picks.
 * The browser then asks the AI to re-rank (lib/match.ts refineWithAi), since the free AI tier limits per IP.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readStore, MatchFailure } from "../lib/match.js";
import { THEMES } from "../lib/themes.js";

const cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 30 * 60 * 1000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const url = typeof req.body?.url === "string" ? req.body.url.slice(0, 200) : "";
  const key = url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return res.status(200).json(hit.body);
  try {
    const result = await readStore(url, THEMES);
    cache.set(key, { at: Date.now(), body: result });
    return res.status(200).json(result);
  } catch (e) {
    if (e instanceof MatchFailure) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: "Something broke on our side. Try again." });
  }
}
