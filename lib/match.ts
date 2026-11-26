/**
 * Reads a Shopify store's public catalog and picks the best-fitting themes from Tiny's four theme studios.
 * The AI step uses Pollinations' free, keyless text API; when it fails, a rule-based scorer answers instead.
 */
import type { MatchResult, Pick, StoreProfile, Theme } from "./types.js";

interface ShopifyProduct {
  title: string;
  vendor: string;
  product_type: string;
  tags: string[] | string;
  options?: { name: string }[];
  variants: { price: string }[];
  images: { src: string }[];
}

const UA = "Mozilla/5.0 (compatible; FittingRoomDemo/1.0)";
const AI_URL = "https://text.pollinations.ai/openai";
const AI_MODEL = "openai-fast";

export function normalizeDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return host.replace(/^www\./, "");
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  return sentence > max / 2 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}...`;
}

function metaContent(html: string, key: string): string {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']*)["']`, "i");
  return decodeEntities(html.match(re)?.[1] ?? "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function detectTheme(html: string, themes: Theme[]): StoreProfile["currentTheme"] {
  const schema = html.match(/Shopify\.theme\s*=\s*\{[^}]*"schema_name"\s*:\s*"([^"]*)"/)?.[1];
  if (!schema) return null;
  const hit = themes.find((t) => t.name.toLowerCase() === schema.toLowerCase());
  return hit ? { name: hit.name, studio: hit.studio } : { name: schema, studio: null };
}

export function buildProfile(domain: string, html: string, products: ShopifyProduct[], themes: Theme[]): StoreProfile {
  const prices = products.flatMap((p) => p.variants.map((v) => Number(v.price))).filter((n) => Number.isFinite(n) && n > 0);
  const typeCounts = new Map<string, number>();
  for (const p of products) {
    const t = p.product_type?.trim();
    if (t) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
  const name = metaContent(html, "og:site_name") || decodeEntities(title).split(/[|–—-]/)[0].trim() || domain;
  const n = products.length || 1;
  return {
    domain,
    name,
    description: clip(metaContent(html, "description") || metaContent(html, "og:description"), 240),
    currentTheme: detectTheme(html, themes),
    productCount: products.length,
    productCountCapped: products.length >= 250,
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMedian: round1(median(prices)),
    priceMax: prices.length ? Math.max(...prices) : 0,
    vendors: new Set(products.map((p) => p.vendor).filter(Boolean)).size,
    topTypes: [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t),
    avgVariants: round1(products.reduce((s, p) => s + p.variants.length, 0) / n),
    avgImages: round1(products.reduce((s, p) => s + p.images.length, 0) / n),
    hasColorOptions: products.some((p) => p.options?.some((o) => /colou?r|shade/i.test(o.name))),
    sampleProducts: products
      .filter((p) => p.images.length)
      .slice(0, 6)
      .map((p) => ({ title: p.title, image: p.images[0]?.src ?? null, price: Number(p.variants[0]?.price ?? 0) })),
  };
}

const has = (t: Theme, re: RegExp) => re.test(`${t.tagline} ${t.highlights} ${t.features}`);

/** Deterministic fallback: catalog size, price point, vertical and media signals against each theme's own listing copy. */
export function ruleScore(s: StoreProfile, t: Theme): { score: number; reasons: string[] } {
  let score = 50;
  const reasons: string[] = [];
  const add = (points: number, reason?: string) => {
    score += points;
    if (reason) reasons.push(reason);
  };
  const count = s.productCountCapped ? "250+" : String(s.productCount);
  const big = s.productCount >= 100;
  const tiny = s.productCount <= 10;
  if (big && has(t, /large (catalog|inventor)|big catalog|high-volume|expansive|scal/i)) add(22, `It's built for large catalogs, and you list ${count} products.`);
  if (big && has(t, /single product|small catalog/i)) add(-25);
  if (tiny && has(t, /single product|small catalog|curat/i)) add(22, `It's made for small, focused catalogs like your ${count} products.`);
  if (tiny && has(t, /large (catalog|inventor)|big catalog/i)) add(-10);
  const types = s.topTypes.join(" ").toLowerCase() + " " + s.description.toLowerCase();
  if (/beauty|cosmetic|skin|makeup|lip/.test(types) && t.slug === "beautify") add(35, "It's the studio's theme made for beauty brands, which matches your catalog.");
  if (/wine|vineyard/.test(types) && t.slug === "vino") add(35, "It's made for wineries, which matches your catalog.");
  if (/apparel|clothing|shirt|dress|fashion|shoe|sneaker/.test(types) && has(t, /apparel|fashion/i)) add(14, "Its listing targets apparel and fashion, a big part of what you sell.");
  if (s.vendors > 15 && has(t, /wholesal|high-volume/i)) add(10, `It handles high-volume, many-brand stores, and you carry ${s.vendors} vendors.`);
  if (s.avgImages >= 5 && has(t, /visual|imagery|image-first|gallery|galleries/i)) add(8, `It leans on imagery, and your products average ${s.avgImages} photos each.`);
  if (s.hasColorOptions && has(t, /swatch/i)) add(6, "It supports color swatches, which your product options use.");
  if (s.priceMedian >= 150 && has(t, /high-end|luxur|premium|boutique/i)) add(6, `It's styled for high-end goods, and your median price is $${s.priceMedian}.`);
  if (t.rating) add((t.rating - 85) / 3);
  return { score: Math.max(5, Math.min(97, Math.round(score))), reasons };
}

export function rulePicks(s: StoreProfile, themes: Theme[]): Pick[] {
  return themes
    .filter((t) => t.name !== s.currentTheme?.name)
    .map((t) => ({ t, ...ruleScore(s, t) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ t, score, reasons }) => ({
      theme: t,
      fit: score,
      why: reasons.slice(0, 2).join(" ") || `It's a well-rated all-rounder for a ${s.productCountCapped ? "250+" : s.productCount}-product store.`,
      watchOut: "Scored by rules, not AI. Preview it on your own products before buying.",
    }));
}

export function buildPrompt(s: StoreProfile, themes: Theme[]): string {
  const catalog = themes
    .map((t) => `- ${t.name} (${t.studio}, $${t.price}${t.rating ? `, ${t.rating}% positive` : ""}): ${t.tagline} ${t.highlights.slice(0, 110)}`)
    .join("\n");
  const store = {
    name: s.name,
    domain: s.domain,
    description: s.description,
    currentTheme: s.currentTheme?.name ?? "unknown",
    products: s.productCountCapped ? "250+" : s.productCount,
    priceRange: [s.priceMin, s.priceMedian, s.priceMax],
    vendors: s.vendors,
    topProductTypes: s.topTypes,
    avgVariantsPerProduct: s.avgVariants,
    avgImagesPerProduct: s.avgImages,
    colorOrShadeOptions: s.hasColorOptions,
    sampleTitles: s.sampleProducts.map((p) => p.title),
  };
  return `You are a senior Shopify merchandiser. Pick the 3 best themes for this store from the catalog below. Only use theme names from the catalog. Do not pick the store's current theme.

STORE (read from its public catalog):
${JSON.stringify(store)}

CATALOG (29 themes from four studios):
${catalog}

Return only JSON, no markdown:
{"read":"2 sentences on what this store is and what its catalog needs from a theme, citing its numbers","picks":[{"theme":"<exact name>","fit":<0-100>,"why":"2 sentences tied to this store's actual data","watchOut":"1 honest sentence on a tradeoff"}]}
Write plainly. No em dashes.`;
}

export function parseAi(text: string, themes: Theme[]): { read: string; picks: Pick[] } | null {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let data: { read?: unknown; picks?: unknown };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data.read !== "string" || !Array.isArray(data.picks)) return null;
  const seen = new Set<string>();
  const picks: Pick[] = [];
  for (const p of data.picks as Record<string, unknown>[]) {
    const theme = themes.find((t) => t.name.toLowerCase() === String(p.theme ?? "").toLowerCase().trim());
    if (!theme || seen.has(theme.slug)) continue;
    seen.add(theme.slug);
    picks.push({
      theme,
      fit: Math.max(0, Math.min(100, Math.round(Number(p.fit) || 0))),
      why: clean(String(p.why ?? "")),
      watchOut: clean(String(p.watchOut ?? "")),
    });
  }
  return picks.length ? { read: clean(data.read), picks: picks.slice(0, 3) } : null;
}

const clean = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").trim();

async function fetchText(url: string, ms: number): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

export class AiUnavailable extends Error {
  readonly retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.retryAfterSec = retryAfterSec;
  }
}

async function askAi(prompt: string): Promise<string> {
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(45_000),
  });
  if (res.status === 402 || res.status === 429) {
    throw new AiUnavailable("The free AI tier allows one reply every 45 seconds per visitor.", Number(res.headers.get("Retry-After")) || 45);
  }
  if (!res.ok) throw new AiUnavailable(`The AI service returned ${res.status}.`, 15);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

export class MatchFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Server side: read the store and answer with the rule-based picks in about a second. */
export async function readStore(input: string, themes: Theme[]): Promise<MatchResult> {
  const started = Date.now();
  const domain = normalizeDomain(input);
  if (!domain) throw new MatchFailure("That doesn't look like a store URL. Try something like allbirds.com.", 400);
  const [home, prods] = await Promise.all([
    fetchText(`https://${domain}/`, 10_000).catch(() => null),
    fetchText(`https://${domain}/products.json?limit=250`, 12_000).catch(() => null),
  ]);
  if (!home?.ok) throw new MatchFailure(`Couldn't load ${domain}. Check the address.`, 422);
  let products: ShopifyProduct[];
  try {
    products = (JSON.parse(prods?.text ?? "") as { products: ShopifyProduct[] }).products;
    if (!Array.isArray(products)) throw new Error();
  } catch {
    throw new MatchFailure(`${domain} doesn't expose a public Shopify catalog, so it's either not on Shopify or it's locked down.`, 422);
  }
  if (!products.length) throw new MatchFailure(`${domain} has no public products to read.`, 422);

  const store = buildProfile(domain, home.text, products, themes);
  return {
    store,
    read: `${store.name} lists ${store.productCountCapped ? "250+" : store.productCount} products across ${store.vendors} vendor${store.vendors === 1 ? "" : "s"}, with a median price of $${store.priceMedian}.`,
    picks: rulePicks(store, themes),
    engine: "rules",
    model: "rule-based scorer",
    ms: Date.now() - started,
  };
}

/**
 * Browser side: ask the AI to re-rank all the studio themes for this store.
 * Runs from the visitor's browser because the free tier rate-limits per IP. Throws AiUnavailable.
 */
export async function refineWithAi(base: MatchResult, themes: Theme[]): Promise<MatchResult> {
  const started = Date.now();
  const candidates = themes.filter((t) => t.name !== base.store.currentTheme?.name);
  const ai = parseAi(await askAi(buildPrompt(base.store, candidates)), candidates);
  if (!ai) throw new AiUnavailable("The AI reply didn't parse, so these are the rule-based picks.", 5);
  return { ...base, read: ai.read, picks: ai.picks, engine: "ai", model: "gpt-oss-20b via Pollinations", ms: base.ms + Date.now() - started };
}

