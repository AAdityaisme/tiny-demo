/**
 * Fitting Room page. POST /api/match returns the store profile with rule-based picks, or final AI picks when the
 * server already has them. Otherwise the AI re-rank runs in this order: this visitor's saved result (localStorage,
 * 24h), the browser lane (refineWithAi, rate-limited per visitor IP), then the server lane (POST /api/refine).
 * When both lanes are busy the rule picks stay, a countdown runs, and the AI is retried once automatically.
 * The page is drawn as a merchandising plan: the 29 themes stand on four studio shelves, the store fills a title
 * block, and the picks are compared side by side. All API and AI text goes into the DOM through textContent.
 */
import { AiUnavailable, normalizeDomain, refineWithAi } from "../lib/match.ts";
import { THEMES } from "../lib/themes.ts";
import type { MatchError, MatchResult, Pick, Studio, StoreProfile, Theme, Vertical } from "../lib/types.ts";

type ErrorKind = "invalid" | "not-shopify" | "empty" | "unreachable" | "network" | "server";
type Status =
  | { kind: "working" }
  | { kind: "busy"; until: number; autoRetry: boolean }
  | { kind: "done"; result: MatchResult; savedAt: string | null };
type Attempt = { ok: true; result: MatchResult } | { ok: false; waitSec: number };

class FitError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const EXAMPLES: { domain: string; name: string; kind: string; photo: string }[] = [
  { domain: "deathwishcoffee.com", name: "Death Wish", kind: "Coffee", photo: "https://cdn.shopify.com/s/files/1/0271/7209/files/DeathWishCoffee_November2026_Product_Bark_Set_Web.jpg?v=1795015213" },
  { domain: "brooklinen.com", name: "Brooklinen", kind: "Bedding", photo: "https://cdn.shopify.com/s/files/1/0951/7126/products/1_Silk_Pillowcase_Blush_Silo_ed32ae4d-be5e-4fda-b7fe-a2f480315c67.jpg?v=1719417493" },
  { domain: "kyliecosmetics.com", name: "Kylie Cosmetics", kind: "Beauty", photo: "https://cdn.shopify.com/s/files/1/0662/4598/4498/files/KJC_HOLIDAY_FY26_CORPORATEPOUCH_ANGLE_DTC_v1_CLNT.jpg?v=1793302230" },
  { domain: "partakefoods.com", name: "Partake", kind: "Cookies", photo: "https://cdn.shopify.com/s/files/1/0012/2296/7353/files/Girl_Scout_Sparkables_Partake_Cookie.png?v=1787935354" },
  { domain: "thursdayboots.com", name: "Thursday", kind: "Boots", photo: "https://cdn.shopify.com/s/files/1/0419/1525/files/03-1024x1024-Men-SummitShirt-Indigo-100626-Front.jpg?v=1794976139" },
  { domain: "allbirds.com", name: "Allbirds", kind: "Shoes", photo: "https://cdn.shopify.com/s/files/1/1104/4168/files/A12032_25Q3_Wool-Runner-NZ-Mid-Waterproof-Natural-Black-Natural-Black-Sole_PDP_LEFT_91ddb877-4dbc-4ba0-a29d-8277624bef25.png?v=1757723606" },
];

const STUDIOS: Studio[] = ["Pixel Union", "Archetype Themes", "Clean Canvas", "Out of the Sandbox"];
const SHELVES: Studio[][] = [["Pixel Union", "Archetype Themes"], ["Clean Canvas"], ["Out of the Sandbox"]];

const VERTICALS: Record<Vertical, string> = {
  apparel: "Apparel",
  beauty: "Beauty",
  "food-drink": "Food and drink",
  "wine-spirits": "Wine and spirits",
  home: "Home goods",
  jewelry: "Jewelry",
  electronics: "Electronics",
  "sports-outdoor": "Sports and outdoors",
  health: "Health and wellness",
  "kids-pets": "Kids and pets",
  "art-media": "Art and media",
};

const GENERIC_IMAGE = "theme-store-social";
const FALLBACK_RETRY_SEC = 15;
const CACHE_PREFIX = "fitting-room:ai:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

const form = document.querySelector<HTMLFormElement>("#match-form")!;
const input = document.querySelector<HTMLInputElement>("#store-url")!;
const submitBtn = document.querySelector<HTMLButtonElement>("#submit-btn")!;
const hint = document.querySelector<HTMLParagraphElement>("#form-hint")!;
const heroChips = document.querySelector<HTMLElement>("#example-chips")!;
const shelves = document.querySelector<HTMLElement>("#shelves")!;
const wallLive = document.querySelector<HTMLElement>(".wall-live")!;
const results = document.querySelector<HTMLElement>("#results")!;
const announcer = document.querySelector<HTMLElement>("#announcer")!;
const params = new URLSearchParams(location.search);
const mock = params.get("mock");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let runId = 0;
let timers: number[] = [];
let mockAiCalls = 0;

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

function icon(name: "arrow" | "check" | "clock" | "retry" | "alert"): SVGSVGElement {
  const paths = {
    arrow: "M5 11 11 5M6 5h5v5",
    check: "m3.5 8.5 3 3 6-7",
    clock: "M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z",
    retry: "M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5",
    alert: "M8 4.5v4.5M8 11.2v.3M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z",
  };
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `icon icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));

const every = (fn: () => void, ms: number) => timers.push(window.setInterval(fn, ms));

function clearTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

const httpUrl = (u: string | null | undefined): string | null =>
  u && /^https?:\/\//i.test(u) ? u : null;

/** Asks Shopify's image CDN for a smaller rendition; other hosts get the original URL. */
function sized(url: string, width: number): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "cdn.shopify.com" && !u.pathname.includes("/cdn/shop/")) return url;
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return url;
  }
}

const money = (n: number): string => {
  const cents = n < 100 && n % 1 ? 2 : 0;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: cents, maximumFractionDigits: cents });
};

const domainOf = (raw: string): string =>
  normalizeDomain(raw) ?? raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, "");

function savedLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "These AI picks were saved earlier, so there was no wait."
    : `These AI picks were saved ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, so there was no wait.`;
}

function announce(text: string): void {
  announcer.textContent = "";
  requestAnimationFrame(() => (announcer.textContent = text));
}

const themeNames = (r: MatchResult) => r.picks.slice(0, 3).map((p) => p.theme.name).join(", ");

function readSaved(domain: string): MatchResult | null {
  if (mock) return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + domain);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { at: number; result: MatchResult };
    const fresh = Date.now() - saved.at < CACHE_TTL_MS;
    if (fresh && saved.result?.engine === "ai" && Array.isArray(saved.result.picks) && saved.result.picks.length) {
      return { ...saved.result, cachedAt: new Date(saved.at).toISOString() };
    }
    localStorage.removeItem(CACHE_PREFIX + domain);
  } catch {
    return null;
  }
  return null;
}

function writeSaved(domain: string, result: MatchResult): void {
  if (mock) return;
  try {
    localStorage.setItem(CACHE_PREFIX + domain, JSON.stringify({ at: Date.now(), result }));
  } catch {
    return;
  }
}

function photo(src: string | null, width: number, alt: string, onFail: () => Node): HTMLElement | Node {
  const url = httpUrl(src);
  if (!url) return onFail();
  const img = h("img", { src: sized(url, width), alt, loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(onFail()), { once: true });
  return img;
}

function chip(ex: (typeof EXAMPLES)[number]): HTMLButtonElement {
  const btn = h(
    "button",
    { type: "button", class: "chip", "data-store": ex.domain },
    h("span", { class: "chip-photo", "aria-hidden": "true" }, photo(ex.photo, 96, "", () => document.createTextNode(""))),
    h(
      "span",
      { class: "chip-text" },
      h("span", { class: "chip-name" }, ex.name),
      h("span", { class: "visually-hidden" }, ", "),
      h("span", { class: "chip-kind" }, ex.kind),
    ),
  );
  btn.addEventListener("click", () => {
    input.value = ex.domain;
    void run(ex.domain);
  });
  return btn;
}

function priceSpan(themes: Theme[]): string {
  const prices = themes.map((t) => t.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? money(lo) : `${money(lo)} to ${money(hi)}`;
}

function facing(theme: Theme): HTMLLIElement {
  const src = httpUrl(theme.image);
  const label = `${theme.name}, ${money(theme.price)}`;
  const media =
    src && !src.includes(GENERIC_IMAGE)
      ? photo(src, 120, label, () => h("span", { class: "facing-blank" }, theme.name))
      : h("span", { class: "facing-blank" }, theme.name);
  const li = h("li", { class: "facing", "data-shape": src?.includes("/theme-store/") ? "phone" : "sheet" }, media);
  li.addEventListener("pointerenter", () => {
    wallLive.textContent = `${theme.name}, ${theme.studio}, ${money(theme.price)}`;
    shelves.parentElement!.classList.add("is-reading");
  });
  return li;
}

function bay(studio: Studio): HTMLElement {
  const themes = THEMES.filter((t) => t.studio === studio);
  const el = h(
    "div",
    { class: "bay", role: "group", "aria-label": `${studio}, ${themes.length} themes` },
    h("ul", { class: "bay-row" }, ...themes.map(facing)),
    h(
      "p",
      { class: "shelf-edge" },
      h("span", { class: "shelf-studio" }, studio),
      h("span", { class: "shelf-meta" }, `${themes.length} themes, ${priceSpan(themes)}`),
    ),
  );
  el.style.setProperty("--n", String(themes.length));
  return el;
}

function drawWall(): void {
  shelves.replaceChildren(...SHELVES.map((row) => h("div", { class: "shelf" }, ...row.map(bay))));
  shelves.addEventListener("pointerleave", () => shelves.parentElement!.classList.remove("is-reading"));
}

function setBusy(busy: boolean): void {
  submitBtn.disabled = busy;
  input.disabled = busy;
  document.querySelectorAll<HTMLButtonElement>(".chip").forEach((c) => (c.disabled = busy));
  submitBtn.textContent = busy ? "Reading store" : "Find my theme";
}

function showHint(message: string): void {
  hint.textContent = message;
  hint.hidden = false;
  input.setAttribute("aria-invalid", "true");
  input.focus();
}

function clearHint(): void {
  hint.hidden = true;
  input.removeAttribute("aria-invalid");
}

function elapsed(from: number, step = 100): HTMLElement {
  const out = h("span", { class: "elapsed", "aria-hidden": "true" }, step < 1000 ? "0.0s" : "0s");
  every(() => (out.textContent = step < 1000 ? seconds(Date.now() - from) : `${Math.round((Date.now() - from) / 1000)}s`), step);
  return out;
}

function stages(labels: string[], delays: number[]): HTMLOListElement {
  const items = labels.map((l) =>
    h("li", { class: "stage" }, h("span", { class: "stage-mark", "aria-hidden": "true" }, icon("check")), h("span", { class: "stage-text" }, l)),
  );
  const mark = (active: number) =>
    items.forEach((li, i) => {
      li.classList.toggle("is-done", i < active);
      li.classList.toggle("is-active", i === active);
      if (i === active) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  delays.forEach((d, i) => later(() => mark(i), d));
  return h("ol", { class: "stages" }, ...items);
}

function showReading(domain: string): void {
  const outline = (n: number, cls: string) => Array.from({ length: n }, () => h("span", { class: cls }));
  results.replaceChildren(
    h(
      "div",
      { class: "drafting" },
      h(
        "div",
        { class: "drafting-head" },
        h("h2", { class: "drafting-title" }, h("span", { class: "drafting-verb" }, "Reading "), domain),
        elapsed(Date.now()),
      ),
      stages(["Opening the storefront", "Reading the public catalog", "Spotting the current theme", "Scoring all 29 themes"], [0, 700, 1500, 2600]),
      h(
        "div",
        { class: "draft-lines", "aria-hidden": "true" },
        h("div", { class: "draft-cells" }, ...outline(6, "draft-cell")),
        h("div", { class: "draft-range" }),
        h("div", { class: "draft-shelf" }, ...outline(6, "draft-item")),
      ),
    ),
  );
  announce(`Reading ${domain}`);
}

function storeError(status: number, body: MatchError | null): FitError {
  const message = body?.error ?? "";
  if (body?.code) return new FitError(body.code, message);
  return new FitError(status === 400 ? "invalid" : "server", message);
}

async function mockMatch(): Promise<MatchResult> {
  await sleep(1500);
  const f = await import("./fixture.ts");
  if (mock === "error") throw new FitError("not-shopify", "fernandfold.com doesn’t expose a public Shopify catalog.");
  if (mock === "offline") throw new FitError("network", "Failed to fetch");
  if (mock === "down") throw new FitError("server", "Something broke on our side.");
  return mock === "cached" ? f.fixtureCached : f.fixtureRules;
}

async function fetchMatch(url: string): Promise<MatchResult> {
  if (mock) return mockMatch();
  let res: Response;
  try {
    res = await fetch("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch {
    throw new FitError("network", "Could not reach the server.");
  }
  const body = (await res.json().catch(() => null)) as MatchResult | MatchError | null;
  if (res.ok && body && !("error" in body)) return body;
  throw storeError(res.status, body && "error" in body ? body : null);
}

async function browserAi(base: MatchResult): Promise<MatchResult> {
  if (!mock) return refineWithAi(base, THEMES);
  mockAiCalls += 1;
  const f = await import("./fixture.ts");
  if (mock === "noai" && mockAiCalls === 1) {
    await sleep(1200);
    throw new AiUnavailable("The free AI tier allows one reply every 45 seconds per visitor.", 45);
  }
  await sleep(mock === "noai" ? 2500 : 4000);
  return f.fixture;
}

async function serverAi(base: MatchResult): Promise<MatchResult> {
  if (mock) {
    await sleep(600);
    throw new AiUnavailable("The server’s AI lane is busy.", 8);
  }
  let res: Response;
  try {
    res = await fetch("/api/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: base.store.domain }),
    });
  } catch {
    throw new AiUnavailable("Could not reach the server’s AI lane.", FALLBACK_RETRY_SEC);
  }
  const body = (await res.json().catch(() => null)) as MatchResult | MatchError | null;
  if (res.ok && body && !("error" in body) && body.engine === "ai") return body;
  const wait = body && "error" in body && body.retryAfterSec ? body.retryAfterSec : FALLBACK_RETRY_SEC;
  throw new AiUnavailable(body && "error" in body ? body.error : `The server returned ${res.status}.`, wait);
}

async function attempt(lane: () => Promise<MatchResult>): Promise<Attempt> {
  try {
    return { ok: true, result: await lane() };
  } catch (e) {
    return { ok: false, waitSec: e instanceof AiUnavailable ? e.retryAfterSec : FALLBACK_RETRY_SEC };
  }
}

function currentTheme(store: StoreProfile): HTMLElement {
  const t = store.currentTheme;
  const note = !t ? "Not detected" : t.studio ? `by ${t.studio}, already a Tiny studio theme` : "Not a Tiny studio theme";
  return h(
    "div",
    { class: `now${t?.studio ? " is-studio" : ""}` },
    h("p", { class: "cell-label" }, "Current theme"),
    h("p", { class: "now-name" }, t ? t.name : "Unknown"),
    h("p", { class: "now-note" }, note),
  );
}

function cell(label: string, value: string): HTMLElement {
  return h("div", { class: "cell" }, h("dt", { class: "cell-label" }, label), h("dd", { class: "cell-value" }, value));
}

function priceRange(store: StoreProfile): HTMLElement | null {
  const { priceMin: lo, priceMax: hi, priceMedian: mid } = store;
  if (!(hi > 0)) return null;
  const at = hi > lo ? Math.max(0, Math.min(100, ((mid - lo) / (hi - lo)) * 100)) : 0;
  const median = h("span", { class: "range-median", "data-align": at < 18 ? "start" : at > 82 ? "end" : "middle" }, `Median ${money(mid)}`);
  const line = h(
    "div",
    { class: "range", role: "img", "aria-label": `Prices run from ${money(lo)} to ${money(hi)}, median ${money(mid)}` },
    h("span", { class: "range-end range-lo", "aria-hidden": "true" }, money(lo)),
    h("span", { class: "range-track", "aria-hidden": "true" }, h("span", { class: "range-tick" }), median),
    h("span", { class: "range-end range-hi", "aria-hidden": "true" }, money(hi)),
  );
  line.style.setProperty("--at", at.toFixed(1));
  return h("div", { class: "range-row" }, h("p", { class: "cell-label" }, "Price range"), line);
}

function product(p: StoreProfile["sampleProducts"][number]): HTMLElement {
  const blank = () => h("span", { class: "product-blank", "aria-hidden": "true" });
  return h(
    "li",
    { class: "product" },
    h("div", { class: "product-well" }, photo(p.image, 360, p.title, blank)),
    h("p", { class: "product-edge" }, h("span", { class: "product-title" }, p.title), h("span", { class: "product-price" }, money(p.price))),
  );
}

function storeSheet(store: StoreProfile): HTMLElement {
  const products = store.productCountCapped ? `${store.productCount}+` : String(store.productCount);
  const vertical = store.vertical ? VERTICALS[store.vertical] : null;
  return h(
    "article",
    { class: "store", "aria-labelledby": "store-name" },
    h(
      "header",
      { class: "store-head" },
      h(
        "div",
        { class: "store-id" },
        h("h2", { id: "store-name", tabindex: "-1" }, store.name || store.domain),
        h(
          "p",
          { class: "store-meta" },
          h("a", { class: "store-domain", href: `https://${domainOf(store.domain)}`, target: "_blank", rel: "noopener" }, store.domain, h("span", { class: "visually-hidden" }, " (opens in a new tab)")),
          vertical ? h("span", { class: "store-vertical" }, vertical) : null,
        ),
        store.description ? h("p", { class: "store-desc" }, store.description) : null,
      ),
      currentTheme(store),
    ),
    h(
      "dl",
      { class: "cells" },
      cell("Products", products),
      cell("Median price", money(store.priceMedian)),
      cell("Vendors", String(store.vendors)),
      cell("Variants each", store.avgVariants.toFixed(1)),
      cell("Photos each", store.avgImages.toFixed(1)),
      cell("Color options", store.hasColorOptions ? "Yes" : "No"),
    ),
    priceRange(store),
    store.topTypes.length
      ? h(
          "div",
          { class: "types" },
          h("p", { class: "cell-label" }, "Sells mostly"),
          h("ul", { class: "tags" }, ...store.topTypes.slice(0, 5).map((t) => h("li", { class: "tag" }, t))),
        )
      : null,
    store.sampleProducts.length
      ? h("ul", { class: "products", "aria-label": "Products from the store" }, ...store.sampleProducts.slice(0, 6).map(product))
      : null,
  );
}

function themeShot(theme: Theme): HTMLElement {
  const placeholder = () => h("span", { class: "shot-blank", "aria-hidden": "true" });
  const src = httpUrl(theme.image);
  const shape = src?.includes("/theme-store/") ? "phone" : "sheet";
  const media = !src || src.includes(GENERIC_IMAGE) ? placeholder() : photo(src, 720, `${theme.name} theme preview`, placeholder);
  return h("div", { class: "pick-shot", "data-shape": shape }, media);
}

function fitRuler(fit: number): HTMLElement {
  const n = Math.max(0, Math.min(100, Math.round(fit)));
  const ruler = h(
    "div",
    { class: "fit" },
    h("p", { class: "fit-label" }, "Fit"),
    h("p", { class: "fit-value" }, h("span", { class: "visually-hidden" }, "Fit score "), String(n), h("span", { class: "fit-of" }, " of 100")),
    h("span", { class: "fit-ruler", "aria-hidden": "true" }, h("span", { class: "fit-fill" })),
  );
  ruler.style.setProperty("--fit", String(n));
  return ruler;
}

function themeLink(theme: Theme): HTMLElement | null {
  const link = httpUrl(theme.url);
  if (!link) return null;
  return h(
    "a",
    { class: "pick-link", href: link, target: "_blank", rel: "noopener" },
    `View on ${hostOf(link)}`,
    h("span", { class: "visually-hidden" }, `, ${theme.name} theme, opens in a new tab`),
    icon("arrow"),
  );
}

function pickCard(pick: Pick, i: number): HTMLElement {
  const { theme } = pick;
  return h(
    "li",
    { class: "pick", "data-rank": String(i + 1) },
    themeShot(theme),
    h(
      "div",
      { class: "pick-head" },
      h("span", { class: "pick-rank", "aria-hidden": "true" }, String(i + 1)),
      h("div", { class: "pick-id" }, h("h3", {}, h("span", { class: "visually-hidden" }, `Pick ${i + 1}: `), theme.name), h(
          "p",
          { class: "pick-meta" },
          h("span", { class: "pick-studio" }, theme.studio),
          h("span", { class: "pick-price" }, h("span", {}, money(theme.price)), theme.rating ? h("span", {}, `${theme.rating}% positive on the Theme Store`) : null),
        )),
    ),
    fitRuler(pick.fit),
    h("div", { class: "pick-why" }, h("p", { class: "pick-label" }, "Why it fits"), h("p", {}, pick.why)),
    pick.watchOut ? h("div", { class: "watch" }, h("p", { class: "pick-label watch-label" }, "Watch out"), h("p", {}, pick.watchOut)) : h("div", { class: "watch is-empty" }),
    h("div", { class: "pick-foot" }, themeLink(theme)),
  );
}

function catalogStrip(r: MatchResult): HTMLElement {
  const rank = new Map(r.picks.slice(0, 3).map((p, i) => [p.theme.slug, i + 1]));
  const cur = r.store.currentTheme;
  const now = cur?.studio ? THEMES.find((t) => t.studio === cur.studio && t.name.toLowerCase() === cur.name.toLowerCase()) : undefined;
  return h(
    "div",
    { class: "strip" },
    h("p", { class: "strip-caption" }, now ? "Where the picks sit among all 29 themes. Outlined in ink: the theme the store runs now." : "Where the picks sit among all 29 themes."),
    h(
      "div",
      { class: "strip-shelves", "aria-hidden": "true" },
      ...STUDIOS.map((studio) =>
        h(
          "div",
          { class: "strip-group" },
          h(
            "div",
            { class: "strip-slots" },
            ...THEMES.filter((t) => t.studio === studio).map((t) => {
              const n = rank.get(t.slug);
              return h("span", { class: `slot${n ? " is-pick" : ""}${t === now ? " is-now" : ""}`, "data-rank": n ? String(n) : "" }, n ? String(n) : "");
            }),
          ),
          h("span", { class: "strip-studio" }, studio),
        ),
      ),
    ),
  );
}

function readBlock(r: MatchResult, pending: boolean, reserved = pending): HTMLElement {
  return h(
    "section",
    { class: `read${r.engine === "ai" ? " is-inked" : ""}${reserved ? " is-reserved" : ""}`, "aria-labelledby": "read-label" },
    h("h2", { class: "read-label", id: "read-label" }, r.engine === "ai" ? "The read" : "Quick read"),
    h(
      "div",
      { class: "read-body" },
      h("p", { class: "read-text" }, r.read),
      pending ? h("div", { class: "read-pending", "aria-hidden": "true" }, h("span"), h("span"), h("span")) : null,
    ),
  );
}

function statusBar(base: MatchResult, id: number, status: Status): HTMLElement {
  if (status.kind === "working") {
    return h(
      "div",
      { class: "ai-status", "data-state": "working" },
      h("span", { class: "ai-pen", "aria-hidden": "true" }),
      h("p", { class: "ai-status-text" }, h("strong", {}, "AI is re-ranking all 29 themes. "), "The rule-based picks below hold until it lands."),
      elapsed(Date.now(), 1000),
    );
  }
  if (status.kind === "done") {
    const note = status.savedAt ? savedLabel(status.savedAt) : `Re-ranked by ${status.result.model} in ${seconds(status.result.ms)}.`;
    return h("div", { class: "ai-status", "data-state": "done" }, icon("check"), h("p", { class: "ai-status-text" }, note));
  }
  const left = () => Math.max(0, Math.ceil((status.until - Date.now()) / 1000));
  const count = h("span", { class: "countdown" }, `${left()}s`);
  const message = h(
    "p",
    { class: "ai-status-text" },
    h("strong", {}, "The free AI is busy. "),
    status.autoRetry ? "Trying again in " : "It frees up in ",
    count,
    ".",
    h("span", { class: "status-more" }, " The rule-based picks hold until then."),
  );
  const now = h("button", { type: "button", class: "btn-line" }, icon("retry"), "Try AI now");
  now.addEventListener("click", () => void refine(base, id, true));
  const tick = () => {
    const n = left();
    count.textContent = `${n}s`;
    if (n > 0) return;
    clearTimers();
    if (status.autoRetry) void refine(base, id, false);
    else message.replaceChildren(h("strong", {}, "The AI should be free now. "), "Try it when you like.");
  };
  every(tick, 1000);
  return h("div", { class: "ai-status", "data-state": "busy" }, icon("clock"), message, now);
}

function renderPicks(base: MatchResult, id: number, status: Status): void {
  const zone = results.querySelector<HTMLElement>(".picks-zone");
  const shown = status.kind === "done" ? status.result : base;
  if (!zone) return;
  clearTimers();
  results.dataset.ai = status.kind;
  const ai = status.kind === "done";
  zone.replaceChildren(
    h(
      "div",
      { class: "picks-head" },
      h("h2", { class: "picks-title" }, "Three themes that fit"),
      h("span", { class: ai ? "engine-pill engine-pill-ai" : "engine-pill" }, ai ? "AI picks" : "Rule-based picks"),
    ),
    statusBar(base, id, status),
    catalogStrip(shown),
    h(
      "ol",
      { class: "picks", "data-engine": ai ? "ai" : "rules", "data-measure": status.kind === "busy" ? "still" : "draw", "aria-label": "Theme picks" },
      ...shown.picks.slice(0, 3).map(pickCard),
    ),
  );
}

function showAi(base: MatchResult, id: number, result: MatchResult, savedAt: string | null): void {
  const read = results.querySelector(".read");
  read?.replaceWith(readBlock(result, false, read.classList.contains("is-reserved")));
  renderPicks(base, id, { kind: "done", result, savedAt });
  announce(`AI picks ready: ${themeNames(result)}.`);
}

async function refine(base: MatchResult, id: number, autoRetry: boolean): Promise<void> {
  clearTimers();
  renderPicks(base, id, { kind: "working" });
  const first = await attempt(() => browserAi(base));
  if (id !== runId) return;
  const final = first.ok ? first : await attempt(() => serverAi(base));
  if (id !== runId) return;
  if (final.ok) {
    writeSaved(base.store.domain, final.result);
    showAi(base, id, final.result, final.result.cachedAt ?? null);
    return;
  }
  const waitSec = Math.max(1, Math.min(first.ok ? Infinity : first.waitSec, final.waitSec));
  renderPicks(base, id, { kind: "busy", until: Date.now() + waitSec * 1000, autoRetry });
  announce(
    autoRetry
      ? `The free AI is busy, so the rule-based picks stay. Trying again in ${waitSec} seconds.`
      : `The free AI is still busy. The rule-based picks stay. You can try again in ${waitSec} seconds.`,
  );
}

const ERROR_COPY: Record<Exclude<ErrorKind, "invalid">, { title: (d: string) => string; body: (d: string) => string; retry: boolean }> = {
  "not-shopify": {
    title: () => "This catalog isn’t public",
    body: (d) => `${d} is either not on Shopify or keeps its product catalog private, so there is nothing to read. Try one of these stores instead.`,
    retry: false,
  },
  empty: {
    title: () => "No public products yet",
    body: (d) => `${d} is on Shopify but lists no public products, so there is nothing to match against. Try one of these stores instead.`,
    retry: false,
  },
  unreachable: {
    title: (d) => `We couldn’t open ${d}`,
    body: () => "Check the spelling of the address and try again, or start from one of these stores.",
    retry: true,
  },
  network: {
    title: () => "You seem to be offline",
    body: () => "Fitting Room couldn’t reach its server. Check your connection, then try again.",
    retry: true,
  },
  server: {
    title: () => "Something broke on our side",
    body: () => "The store reader hit an error. It is usually brief, so try again in a moment.",
    retry: true,
  },
};

function showError(kind: Exclude<ErrorKind, "invalid">, domain: string, url: string): void {
  const copy = ERROR_COPY[kind];
  const retry = h("button", { type: "button", class: "btn-ink btn-compact" }, icon("retry"), "Try again");
  retry.addEventListener("click", () => void run(url));
  const examples = kind === "network" || kind === "server" ? [] : EXAMPLES.filter((e) => e.domain !== domain).slice(0, 3);
  results.replaceChildren(
    h(
      "div",
      { class: "error card", role: "alert", "data-kind": kind },
      h("h2", { class: "error-title" }, icon("alert"), h("span", {}, copy.title(domain))),
      h("p", { class: "error-body" }, copy.body(domain)),
      examples.length ? h("div", { class: "chips error-chips" }, ...examples.map(chip)) : null,
      copy.retry ? h("div", { class: "error-actions" }, retry) : null,
    ),
  );
}

async function run(raw: string): Promise<void> {
  const url = raw.trim();
  const domain = normalizeDomain(url);
  if (!url) return showHint("Enter a store address, like deathwishcoffee.com.");
  if (!domain) return showHint("That doesn’t look like a store address. Try something like deathwishcoffee.com.");
  const id = ++runId;
  clearTimers();
  clearHint();
  input.value = url;
  setBusy(true);
  showReading(domain ?? url);
  results.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
  let rules: MatchResult;
  try {
    rules = await fetchMatch(url);
  } catch (e) {
    if (id !== runId) return;
    clearTimers();
    setBusy(false);
    const kind = e instanceof FitError ? e.kind : "server";
    if (kind === "invalid") {
      results.replaceChildren();
      return showHint("That doesn’t look like a store address. Try something like deathwishcoffee.com.");
    }
    return showError(kind, domain ?? url, url);
  }
  if (id !== runId) return;
  clearTimers();
  setBusy(false);
  const saved = rules.engine === "ai" ? null : readSaved(rules.store.domain);
  const final = rules.engine === "ai" ? rules : saved;
  results.replaceChildren(storeSheet(rules.store), readBlock(final ?? rules, !final), h("div", { class: "picks-zone" }));
  const next = new URLSearchParams(location.search);
  next.set("store", rules.store.domain || domainOf(url));
  history.replaceState(null, "", `?${next}`);
  results.querySelector<HTMLElement>("#store-name")?.focus({ preventScroll: true });
  if (final) return showAi(rules, id, final, final.cachedAt ?? null);
  announce(`${rules.store.name || rules.store.domain}: rule-based picks are ${themeNames(rules)}. AI is re-ranking.`);
  await refine(rules, id, true);
}

drawWall();
heroChips.replaceChildren(...EXAMPLES.map(chip));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void run(input.value);
});

input.addEventListener("input", () => {
  if (!hint.hidden) clearHint();
});

const initial = params.get("store");
if (initial) {
  input.value = initial;
  void run(initial);
}
