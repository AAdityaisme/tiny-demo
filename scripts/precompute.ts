/**
 * Precomputes AI picks into data/snapshots.json so /api/match can serve them with no AI call.
 * Usage: npm run precompute -- deathwishcoffee.com brooklinen.com
 * Waits out the keyless tier's Retry-After between calls and retries a reply that doesn't parse once.
 * Writes after each store, so an interrupted run keeps what it finished.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AiRateLimited, AiUnavailable, normalizeDomain, readStore, refineWithAi } from "../lib/match.ts";
import { THEMES } from "../lib/themes.ts";
import type { MatchResult } from "../lib/types.ts";

const FILE = new URL("../data/snapshots.json", import.meta.url);
const MAX_RATE_LIMIT_WAITS = 6;

const sleep = (sec: number) => new Promise((r) => setTimeout(r, sec * 1000));

async function refineWithRetries(base: MatchResult): Promise<MatchResult> {
  let parseRetries = 1;
  for (let waits = 0; ; ) {
    try {
      return await refineWithAi(base, THEMES);
    } catch (e) {
      if (e instanceof AiRateLimited && waits++ < MAX_RATE_LIMIT_WAITS) {
        console.log(`  rate-limited, waiting ${e.retryAfterSec + 1}s`);
        await sleep(e.retryAfterSec + 1);
      } else if (e instanceof AiUnavailable && !(e instanceof AiRateLimited) && parseRetries-- > 0) {
        console.log(`  ${e.message} Retrying once.`);
        await sleep(e.retryAfterSec);
      } else {
        throw e;
      }
    }
  }
}

const domains = process.argv.slice(2).map((d) => normalizeDomain(d) ?? d);
if (!domains.length) {
  console.error("Usage: npm run precompute -- <domain> [<domain> ...]");
  process.exit(1);
}
const snapshots = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, MatchResult>;
let failed = 0;
for (const domain of domains) {
  console.log(domain);
  try {
    const result = await refineWithRetries(await readStore(domain, THEMES));
    snapshots[domain] = { ...result, cachedAt: new Date().toISOString() };
    writeFileSync(FILE, `${JSON.stringify(snapshots, null, 1)}\n`);
    console.log(`  ${result.picks.map((p) => `${p.theme.name} (${p.fit})`).join(", ")}`);
  } catch (e) {
    failed++;
    console.error(`  failed: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(failed ? 1 : 0);
