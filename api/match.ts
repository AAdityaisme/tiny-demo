/**
 * POST /api/match {url}: read a Shopify store and return its profile with rule-based picks, or AI picks
 * already computed for that store (a committed snapshot or this instance's cache, with `cachedAt`).
 * Otherwise the browser asks the AI to re-rank (lib/match.ts refineWithAi), falling back to /api/refine.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { MatchFailure } from "../lib/match.js";
import { cachedAi, domainOf, storeResult } from "../lib/server.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const domain = domainOf(req.body);
  if (!domain) return res.status(400).json({ error: "That doesn't look like a store URL. Try something like allbirds.com." });
  const ai = cachedAi(domain);
  if (ai) return res.status(200).json(ai);
  try {
    return res.status(200).json(await storeResult(domain));
  } catch (e) {
    if (e instanceof MatchFailure) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: "Something broke on our side. Try again." });
  }
}
