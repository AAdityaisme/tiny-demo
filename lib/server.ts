/**
 * Server-only state shared by api/match.ts and api/refine.ts: per-domain store reads, AI results, and the
 * committed AI snapshots in data/snapshots.json (written by scripts/precompute.ts).
 * The in-memory maps live per function instance, so only snapshots survive cold starts.
 */
import snapshots from "../data/snapshots.json" with { type: "json" };
import { normalizeDomain, readStore } from "./match.js";
import { THEMES } from "./themes.js";
import type { MatchResult } from "./types.js";

const SNAPSHOTS = snapshots as Record<string, MatchResult>;
const STORE_TTL_MS = 30 * 60 * 1000;
const stores = new Map<string, { at: number; result: MatchResult }>();
const aiResults = new Map<string, MatchResult>();

/** The cache key for a request body's `url`: the normalized store domain, or null when it isn't a store URL we may fetch. */
export function domainOf(body: unknown): string | null {
  const url = (body as { url?: unknown } | null)?.url;
  return typeof url === "string" ? normalizeDomain(url.slice(0, 200)) : null;
}

/** Rule-based read of a store, cached for 30 minutes. Throws MatchFailure. */
export async function storeResult(domain: string): Promise<MatchResult> {
  const hit = stores.get(domain);
  if (hit && Date.now() - hit.at < STORE_TTL_MS) return hit.result;
  const result = await readStore(domain, THEMES);
  stores.set(domain, { at: Date.now(), result });
  return result;
}

/** AI picks already computed for this domain: a committed snapshot wins over this instance's cache. */
export function cachedAi(domain: string): MatchResult | null {
  return SNAPSHOTS[domain] ?? aiResults.get(domain) ?? null;
}

/** Keep a fresh AI result for later requests, stamped with when it was computed. */
export function rememberAi(domain: string, result: MatchResult): void {
  aiResults.set(domain, { ...result, cachedAt: new Date().toISOString() });
}
