import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile, classifyStore, clip, detectTheme, normalizeDomain, parseAi, rulePicks } from "./match.ts";
import { THEMES } from "./themes.ts";

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
