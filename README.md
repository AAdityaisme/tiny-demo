# Fitting Room

**Live:** https://fitting-room.vercel.app

Paste any Shopify store URL. Fitting Room reads the store's public catalog and current theme, then picks the three best themes from the 29 sold by Tiny's four theme studios (Pixel Union, Archetype Themes, Clean Canvas, Out of the Sandbox), with reasons tied to that store's own numbers. Each pick links to the theme's page on its studio's site.

An unofficial demo. Not affiliated with Tiny.

## The problem

The four studios share one site nav and one audience ("700k+ Shopify merchants"), and between them they sell 29 premium themes. A merchant has to guess which one fits. The finder that exists today, on pixelunion.net, is a filter quiz over a handful of Pixel Union themes, and it shows "this tool was built to be used on a larger screen" on a phone.

## What it does

1. **Reads the store.** `api/match.ts` fetches the store's homepage and its public `/products.json`: product count, price spread, vendors, product types, variants, photos, color options, the current theme, and the store's vertical (coffee, beauty, apparel and so on).
2. **Filters what can fit.** A theme built for one vertical (Tailor for apparel, Beautify for beauty, Vino for wine) is only offered to stores in that vertical, and catalog size rules keep single-product themes away from 250-product stores. This runs in code, before and after the AI.
3. **Ranks.** A rule-based scorer weighs category, catalog size and price point and answers in about a second. Then an LLM re-ranks the eligible themes and writes a read of the store plus a reason and a tradeoff for each pick. Its output is checked against the catalog and the same eligibility rules.

The catalog (`data/themes.json`) comes from the Shopify Theme Store listings and the studios' own sites (`scripts/build-catalog.py`).

## The AI, with no API key

It uses Pollinations' free, keyless text API (`gpt-oss-20b`), which allows one new reply about every 45 seconds per IP. So:

- The example stores are precomputed (`npm run precompute -- <domains>`, saved in `lib/snapshots.ts`) and load instantly.
- Each visitor's browser calls the AI from its own IP. If that lane is busy, the server tries from its IP (`/api/refine`) and caches the result per store.
- If both are busy, the rule picks stay on screen and the AI retries by itself when the wait ends.
- The request for a store is byte-identical each time, so Pollinations can answer repeats from its cache.

## Run it

```bash
npm install
npm test          # node:test on lib/
npm run build     # typecheck + vite build
vercel dev        # page + API locally
```

`?store=allbirds.com` runs a store as soon as the page opens. `?mock=1` runs against a fixture with no network; `?mock=noai`, `cached`, `error`, `offline` and `down` show the other states.

## How it was built

Built with an agent swarm: an orchestrator researched Tiny's portfolio and the theme catalog from primary sources, and worker agents built the matching logic and the page in parallel against a shared type contract (`lib/types.ts`). The orchestrator merged, verified and deployed.

Vanilla TypeScript and CSS on Vite, with one Vercel function. No framework and no runtime dependencies.
