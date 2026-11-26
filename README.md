# Fitting Room

**Live:** https://fitting-room.vercel.app

Paste any Shopify store URL. Fitting Room reads the store's public catalog and current theme, then picks the three best themes from the 29 sold by Tiny's four theme studios (Pixel Union, Archetype Themes, Clean Canvas, Out of the Sandbox), with reasons tied to that store's own numbers.

An unofficial demo. Not affiliated with Tiny.

## The problem

The four studios share one site nav and one audience ("700k+ Shopify merchants"), and between them they sell 29 premium themes. A merchant has to guess which one fits. The finder that exists today, on pixelunion.net, is a filter quiz over a handful of Pixel Union themes, and it shows "this tool was built to be used on a larger screen" on a phone.

## What it does

1. **Reads the store.** `api/match.ts` fetches the store's homepage and its public `/products.json`. From that it gets the product count, price spread, vendors, top product types, variants, photos per product, color or shade options, and the current theme (from `Shopify.theme.schema_name`). Death Wish Coffee, for example, has 152 products and runs free Dawn.
2. **Gives an instant answer.** A rule-based scorer matches those signals against each theme's own listing copy and returns three picks in about a second.
3. **The AI re-ranks.** The browser sends the store profile and all 29 themes to an LLM, which returns a short read of the store and three picks, each with a reason and a tradeoff. The output is checked against the real catalog, so the model can't invent a theme.

The catalog (`data/themes.json`) was pulled today from the Shopify Theme Store listings and from outofthesandbox.com (`scripts/build-catalog.py`).

## The AI, with no API key

It uses Pollinations' free, keyless text API (`gpt-oss-20b`). The free tier allows one reply every 45 seconds per IP, so the call runs from the visitor's browser instead of a shared server IP. If the AI is unavailable, the page keeps the rule-based picks, labels them, and offers a retry once the cooldown ends.

## Run it

```bash
npm install
npm test          # node:test on lib/
npm run build     # typecheck + vite build
vercel dev        # page + /api/match locally
```

`?mock=1` runs the page against a fixture with no network. `?store=allbirds.com` runs a store as soon as the page opens.

## How it was built

Built in an afternoon with an agent swarm. An orchestrator agent researched Tiny's portfolio and the theme catalog from primary sources, then wrote the store reader and AI layer. Meanwhile a second agent built the page against a shared type contract (`lib/types.ts`). The orchestrator checked the whole thing end to end on the live deployment.

Vanilla TypeScript and CSS on Vite, with one Vercel function. No framework and no runtime dependencies.
