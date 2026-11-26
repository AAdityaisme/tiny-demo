/**
 * One function for both lanes, so they share this instance's caches.
 * POST /api/match {url}: the store profile with rule-based picks, or AI picks already computed for that store
 * (a committed snapshot or this instance's cache, with `cachedAt`).
 * POST /api/refine {url} (rewritten here with ?lane=refine): the server's own AI lane, for when the visitor's
 * browser is rate-limited. It reads the store itself, never a client-sent profile, and returns a MatchResult,
 * 429 {error, retryAfterSec} while the keyless AI tier is limiting this server, or 502 when the reply didn't parse.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AiRateLimited, AiUnavailable, MatchFailure, refineWithAi } from "../lib/match.js";
import { cachedAi, domainOf, rememberAi, storeResult } from "../lib/server.js";
import { THEMES } from "../lib/themes.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const domain = domainOf(req.body);
  if (!domain) return res.status(400).json({ error: "That doesn't look like a store URL. Try something like allbirds.com.", code: "invalid" });
  const ai = cachedAi(domain);
  if (ai) return res.status(200).json(ai);
  try {
    const rules = await storeResult(domain);
    if (req.query.lane !== "refine") return res.status(200).json(rules);
    const result = await refineWithAi(rules, THEMES);
    rememberAi(domain, result);
    return res.status(200).json(result);
  } catch (e) {
    if (e instanceof MatchFailure) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e instanceof AiRateLimited) {
      return res.status(429).json({ error: `The shared AI lane is busy. Try again in ${e.retryAfterSec} seconds.`, retryAfterSec: e.retryAfterSec });
    }
    if (e instanceof AiUnavailable) return res.status(502).json({ error: e.message, retryAfterSec: e.retryAfterSec });
    return res.status(500).json({ error: "Something broke on our side. Try again." });
  }
}
