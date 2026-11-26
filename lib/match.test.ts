import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { AiRateLimited, AiUnavailable, buildProfile, buildPrompt, catalogSize, classifyStore, clip, eligibleThemes, detectTheme, normalizeDomain, parseAi, refineWithAi, rulePicks } from "./match.ts";
import { THEMES } from "./themes.ts";
import type { MatchResult, StoreProfile } from "./types.ts";

test("normalizeDomain accepts store URLs and rejects hosts we must not fetch", () => {
  assert.equal(normalizeDomain("https://www.Allbirds.com/collections/men"), "allbirds.com");
  assert.equal(normalizeDomain("gymshark.com"), "gymshark.com");
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain("http://169.254.169.254/latest"), null);
  assert.equal(normalizeDomain("not a url"), null);
});

test("detectTheme maps a Tiny studio theme and passes others through", () => {
  const html = (n: string) => `<script>Shopify.theme = {"name":"Live","id":1,"schema_name":"${n}","role":"main"};</script>`;
  assert.deepEqual(detectTheme(html("Impulse"), THEMES), { name: "Impulse", studio: "Archetype Themes" });
  assert.deepEqual(detectTheme(html("Dawn"), THEMES), { name: "Dawn", studio: null });
  assert.equal(detectTheme("<html></html>", THEMES), null);
});

const product = (i: number, type: string) => ({
  title: `Product ${i}`, vendor: `V${i % 3}`, product_type: type, tags: [],
  options: [{ name: "Shade" }], variants: [{ price: "20.00" }, { price: "30.00" }], images: [{ src: `https://x/${i}.jpg` }],
});

test("profile and rules: a big cosmetics catalog gets Beautify, AI output is validated against the catalog", () => {
  const products = Array.from({ length: 250 }, (_, i) => product(i, "Lipstick"));
  const s = buildProfile("x.com", '<meta property="og:site_name" content="Glow &amp; Co">', products, THEMES);
  assert.equal(s.name, "Glow & Co");
  assert.equal(s.productCountCapped, true);
  assert.equal(s.priceMedian, 25);
  assert.equal(s.hasColorOptions, true);
  assert.equal(rulePicks(s, THEMES)[0].theme.slug, "beautify");

  const ai = parseAi('noise {"read":"A store — big.","picks":[{"theme":"Made Up","fit":99},{"theme":"empire","fit":140,"why":"w","watchOut":"o"},{"theme":"Empire","fit":50}]}', THEMES);
  assert.ok(ai);
  assert.equal(ai.read, "A store, big.");
  assert.equal(ai.picks.length, 1);
  assert.equal(ai.picks[0].theme.name, "Empire");
  assert.equal(ai.picks[0].fit, 100);
  assert.equal(parseAi("no json here", THEMES), null);
});

test("clip ends on a sentence or a whole word", () => {
  assert.equal(clip("Short.", 50), "Short.");
  assert.equal(clip("One sentence here. Another sentence that runs long", 30), "One sentence here.");
  assert.equal(clip("averyveryverylongword another word here", 30), "averyveryverylongword another...");
});

const items = (n: number, product_type: string, title = product_type, tags: string[] = []) =>
  Array.from({ length: n }, (_, i) => ({ title: `${title} ${i}`, product_type, tags }));

test("classifyStore reads the vertical from product types, tags, titles and the store's own copy", () => {
  assert.equal(classifyStore({
    name: "Death Wish Coffee",
    description: "We source USDA Organic arabica and robusta coffee beans for our everyday coffee roasts.",
    products: [...items(37, "Apparel", "Skull Tee"), ...items(36, "Coffee", "Dark Roast"), ...items(25, "Coffee Bundle"), ...items(27, "Accessories", "Sticker"), ...items(7, "Mugs")],
  }), "food-drink");
  assert.equal(classifyStore({ name: "Brooklinen", description: "", products: [...items(73, "Content", "Content: BFCM"), ...items(42, "Sheets"), ...items(23, "Towels"), ...items(16, "Blankets"), ...items(10, "Duvet Covers")] }), "home");
  assert.equal(classifyStore({ name: "Kylie Cosmetics", description: "Award-winning makeup, fragrance, and skincare.", products: [...items(97, "Bundle", "Look Bundle"), ...items(26, "Set"), ...items(6, "Lip Kit"), ...items(5, "Lip Gloss")] }), "beauty");
  assert.equal(classifyStore({ name: "Partake Foods", description: "Our super delicious cookies.", products: [...items(10, "Cookies"), ...items(4, "", "Snack Pack", ["type_Snack Packs"])] }), "food-drink");
  assert.equal(classifyStore({ name: "Thursday Boot Company", description: "Work boots and fashion boots.", products: [...items(50, "boots"), ...items(47, "Socks"), ...items(35, "Shoes"), ...items(31, "Shirts"), ...items(17, "Bags")] }), "apparel");
  assert.equal(classifyStore({ name: "Allbirds", description: "", products: [...items(159, "Shoes", "Wool Runner"), ...items(50, "Socks"), ...items(37, "", "Gift")] }), "apparel");
  assert.equal(classifyStore({ name: "Acme", description: "", products: [...items(20, "Widget"), ...items(5, "Gadget")] }), null);
  assert.equal(classifyStore({ name: "Mixed Goods", description: "", products: [...items(10, "Shirts"), ...items(10, "Candles"), ...items(10, "Coffee")] }), null);
});

const profile = (over: Partial<StoreProfile>): StoreProfile => ({
  domain: "x.com", name: "X", description: "", currentTheme: null, productCount: 152, productCountCapped: false,
  priceMin: 5, priceMedian: 32.5, priceMax: 300, vendors: 1, topTypes: [], avgVariants: 3, avgImages: 4,
  hasColorOptions: false, vertical: null, sampleProducts: [], ...over,
});
const coffee = profile({ name: "Death Wish Coffee", vertical: "food-drink", topTypes: ["Apparel", "Coffee", "Accessories", "Coffee Bundle", "Mugs"] });

test("eligibility: vertical themes only serve their vertical, catalog sizes are respected", () => {
  const slugs = (s: StoreProfile) => eligibleThemes(s, THEMES).map((t) => t.slug);
  assert.ok(!slugs(coffee).includes("tailor"));
  assert.ok(!slugs(coffee).includes("beautify"));
  assert.ok(!slugs(profile({ vertical: null })).includes("tailor"));
  assert.ok(slugs(profile({ vertical: "apparel" })).includes("tailor"));
  assert.ok(!rulePicks(coffee, THEMES).some((p) => p.theme.slug === "tailor"));

  const tiny = profile({ productCount: 5 });
  for (const p of rulePicks(tiny, THEMES)) assert.ok(p.theme.catalog.includes("small"), `${p.theme.name} is not for small catalogs`);
  const huge = profile({ productCount: 250, productCountCapped: true });
  assert.ok(!slugs(huge).includes("startup"));
  for (const p of rulePicks(huge, THEMES)) assert.ok(p.theme.catalog.includes("large"), `${p.theme.name} is not for large catalogs`);
  assert.equal(catalogSize(1), "single");
  assert.equal(catalogSize(5), "small");
  assert.equal(catalogSize(152), "medium");
  assert.equal(catalogSize(250), "large");
});

const aiReply = (picks: string[]) => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ read: "A coffee brand.", picks: picks.map((theme) => ({ theme, fit: 90, why: "w", watchOut: "o" })) }) } }] });

test("AI picks are re-checked against eligibility, backfilled to 3, and the request is deterministic", async () => {
  const bodies: string[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return new Response(aiReply(["Tailor", "Beautify", "Empire"]), { status: 200 });
  });
  try {
    const base: MatchResult = { store: coffee, read: "", picks: rulePicks(coffee, THEMES), engine: "rules", model: "rules", ms: 1 };
    const out = await refineWithAi(base, THEMES);
    assert.equal(out.engine, "ai");
    assert.deepEqual(out.picks.map((p) => p.theme.slug).slice(0, 1), ["empire"]);
    assert.equal(out.picks.length, 3);
    assert.ok(!out.picks.some((p) => p.theme.slug === "tailor" || p.theme.slug === "beautify"));
    await refineWithAi(base, THEMES);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(typeof JSON.parse(bodies[0]).seed, "number");
  } finally {
    fetchMock.mock.restore();
  }
});

test("the AI prompt lists only eligible themes and states the store's vertical, size and price band", () => {
  const prompt = buildPrompt(coffee, THEMES);
  assert.ok(!prompt.includes("- Tailor ("));
  assert.ok(!prompt.includes("- Startup ("));
  assert.ok(prompt.includes("- Empire ("));
  assert.match(prompt, /food-drink/);
  assert.match(prompt, /medium/);
  assert.match(prompt, /value/);
  assert.match(prompt, /category, catalog size and price point/);
});

test("a 402 from the keyless tier surfaces as a rate limit with its Retry-After", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("limited", { status: 402, headers: { "Retry-After": "38" } }));
  try {
    const base: MatchResult = { store: coffee, read: "", picks: [], engine: "rules", model: "rules", ms: 1 };
    await assert.rejects(refineWithAi(base, THEMES), (e) => e instanceof AiRateLimited && e instanceof AiUnavailable && e.retryAfterSec === 38);
  } finally {
    fetchMock.mock.restore();
  }
});

test("rule picks never repeat a why, and prices read as money", () => {
  const picks = rulePicks(profile({ ...coffee, productCount: 152, priceMedian: 32.5, vendors: 17 }), THEMES);
  assert.equal(new Set(picks.map((p) => p.why)).size, 3);
  assert.ok(picks.some((p) => p.why.includes("$32.50")));
  assert.ok(picks.every((p) => !p.why.includes("$32.5 ")));
});

test("AI text never shows a raw vertical label", () => {
  const ai = parseAi('{"read":"A food-drink brand at $32.5, not $1.25.","picks":[{"theme":"Empire","fit":80,"why":"Fits food‑drink stores at $19.6.","watchOut":""}]}', THEMES);
  assert.equal(ai?.read, "A food and drink brand at $32.50, not $1.25.");
  assert.equal(ai?.picks[0].why, "Fits food and drink stores at $19.60.");
  assert.equal(ai?.picks[0].watchOut, "Preview it with your own products before you buy.");
  const ranked = parseAi('{"read":"r","picks":[{"theme":"Tailor","fit":92},{"theme":"Empire","fit":86},{"theme":"Canopy","fit":88}]}', THEMES);
  assert.deepEqual(ranked?.picks.map((p) => p.fit), [92, 88, 86]);
});
