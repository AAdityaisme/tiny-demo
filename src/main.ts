/**
 * Fitting Room page. POST /api/match returns the store profile with rule-based picks, or final AI picks when the
 * server already has them. Otherwise the AI re-rank runs in this order: this visitor's saved result (localStorage,
 * 24h), the browser lane (refineWithAi, rate-limited per visitor IP), then the server lane (POST /api/refine).
 * When both lanes are busy the rule picks stay, a countdown runs, and the AI is retried once automatically.
 * lib/match.ts MatchFailure carries no error code, so 422 kinds are told apart by their message.
 * All API and AI text goes into the DOM through textContent.
 */
import { AiUnavailable, normalizeDomain, refineWithAi } from "../lib/match.ts";
import { THEMES } from "../lib/themes.ts";
import type { MatchError, MatchResult, Pick, StoreProfile, Theme, Vertical } from "../lib/types.ts";

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

const EXAMPLES: { domain: string; name: string; kind: string }[] = [
  { domain: "deathwishcoffee.com", name: "Death Wish", kind: "Coffee" },
  { domain: "brooklinen.com", name: "Brooklinen", kind: "Bedding" },
  { domain: "kyliecosmetics.com", name: "Kylie Cosmetics", kind: "Beauty" },
  { domain: "partakefoods.com", name: "Partake", kind: "Cookies" },
  { domain: "thursdayboots.com", name: "Thursday", kind: "Boots" },
  { domain: "allbirds.com", name: "Allbirds", kind: "Shoes" },
];

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

function icon(name: "arrow" | "check" | "clock" | "retry"): SVGSVGElement {
  const paths = {
    arrow: "M5 11 11 5M6 5h5v5",
    check: "m4 8.5 2.5 2.5L12 5.5",
    clock: "M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z",
    retry: "M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5",
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

function chip(ex: (typeof EXAMPLES)[number]): HTMLButtonElement {
  const btn = h(
    "button",
    { type: "button", class: "chip", "data-store": ex.domain },
    h("span", { class: "chip-name" }, ex.name),
    h("span", { class: "visually-hidden" }, ", "),
    h("span", { class: "chip-kind" }, ex.kind),
  );
  btn.addEventListener("click", () => {
    input.value = ex.domain;
    void run(ex.domain);
  });
  return btn;
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

function stages(labels: string[], delays: number[]): HTMLOListElement {
  const items = labels.map((l) => h("li", { class: "stage" }, h("span", { class: "stage-dot", "aria-hidden": "true" }), l));
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
  const bars = (n: number, cls: string) => Array.from({ length: n }, () => h("span", { class: `skel ${cls}` }));
  results.replaceChildren(
    h(
      "div",
      { class: "progress card" },
      h(
        "div",
        { class: "progress-head" },
        h("h2", { class: "progress-title" }, domain),
        stages(["Opening the storefront", "Reading the public catalog", "Spotting the current theme", "Scoring 29 themes"], [0, 700, 1500, 2600]),
      ),
      h("div", { class: "skel-stats", "aria-hidden": "true" }, ...bars(4, "skel-stat")),
      h("div", { class: "skel-thumbs", "aria-hidden": "true" }, ...bars(6, "skel-thumb")),
    ),
  );
  announce(`Reading ${domain}`);
}

function storeError(status: number, message: string): FitError {
  if (status === 400) return new FitError("invalid", message);
  if (status === 422 && /catalog/i.test(message)) return new FitError("not-shopify", message);
  if (status === 422 && /no public products/i.test(message)) return new FitError("empty", message);
  if (status === 422) return new FitError("unreachable", message);
  return new FitError("server", message);
}

async function mockMatch(): Promise<MatchResult> {
  await sleep(1500);
  const f = await import("./fixture.ts");
  if (mock === "error") throw new FitError("not-shopify", "fernandfold.com doesn't expose a public Shopify catalog.");
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
  throw storeError(res.status, body && "error" in body ? body.error : "");
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
    throw new AiUnavailable("The server's AI lane is busy.", 8);
  }
  let res: Response;
  try {
    res = await fetch("/api/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: base.store.domain }),
    });
  } catch {
    throw new AiUnavailable("Could not reach the server's AI lane.", FALLBACK_RETRY_SEC);
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

function themeBadge(store: StoreProfile): HTMLElement {
  const t = store.currentTheme;
  if (!t) return h("p", { class: "badge badge-muted" }, "Theme not detected");
  if (t.studio) return h("p", { class: "badge badge-tiny" }, `Already on ${t.name} by ${t.studio}`);
  return h("p", { class: "badge" }, `Now on ${t.name}`);
}

function stat(label: string, value: string): HTMLElement {
  return h("div", { class: "stat" }, h("dt", {}, label), h("dd", {}, value));
}

function thumb(p: StoreProfile["sampleProducts"][number]): HTMLElement {
  const fallback = () => h("div", { class: "thumb-fallback" }, p.title);
  const src = httpUrl(p.image);
  let media: HTMLElement = fallback();
  if (src) {
    const img = h("img", { src, alt: p.title, loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
    media = img;
  }
  return h("li", { class: "thumb" }, media, h("span", { class: "thumb-price" }, money(p.price)));
}

function storeCard(store: StoreProfile): HTMLElement {
  const products = store.productCountCapped ? `${store.productCount}+` : String(store.productCount);
  const vertical = store.vertical ? VERTICALS[store.vertical] : null;
  return h(
    "article",
    { class: "store card", "aria-labelledby": "store-name" },
    h(
      "div",
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
      ),
      themeBadge(store),
    ),
    store.description ? h("p", { class: "store-desc" }, store.description) : null,
    h(
      "dl",
      { class: "stats" },
      stat("Products", products),
      stat("Median price", money(store.priceMedian)),
      stat("Vendors", String(store.vendors)),
      stat("Avg variants", store.avgVariants.toFixed(1)),
    ),
    store.topTypes.length
      ? h(
          "div",
          { class: "types" },
          h("span", { class: "types-label" }, "Top product types"),
          h("ul", { class: "tags" }, ...store.topTypes.slice(0, 5).map((t) => h("li", { class: "tag" }, t))),
        )
      : null,
    store.sampleProducts.length
      ? h("ul", { class: "thumbs", "aria-label": "Sample products" }, ...store.sampleProducts.slice(0, 6).map(thumb))
      : null,
  );
}

function themeMedia(theme: Theme): HTMLElement {
  const placeholder = () => h("div", { class: "pick-placeholder", "aria-hidden": "true" }, h("span", {}, theme.name));
  const src = httpUrl(theme.image);
  if (!src || src.includes(GENERIC_IMAGE)) return placeholder();
  const img = h("img", { src, alt: `${theme.name} theme preview`, loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(placeholder()), { once: true });
  return img;
}

function fitRing(fit: number): HTMLElement {
  const n = Math.max(0, Math.min(100, Math.round(fit)));
  const ring = h("div", { class: "fit", role: "img", "aria-label": `Fit score ${n} out of 100` }, h("span", { "aria-hidden": "true" }, String(n)));
  ring.style.setProperty("--fit", String(n));
  return ring;
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
    { class: "pick card" },
    h("div", { class: "pick-media" }, themeMedia(theme), h("span", { class: "pick-rank" }, h("span", { class: "visually-hidden" }, `Pick ${i + 1}`), h("span", { "aria-hidden": "true" }, `0${i + 1}`))),
    h(
      "div",
      { class: "pick-body" },
      h(
        "div",
        { class: "pick-head" },
        h("div", {}, h("h3", {}, theme.name), h("p", { class: "pick-meta" }, `${theme.studio} · ${money(theme.price)}`)),
        fitRing(pick.fit),
      ),
      h("p", { class: "pick-why" }, pick.why),
      pick.watchOut ? h("div", { class: "watch" }, h("p", { class: "watch-label" }, "Watch out"), h("p", {}, pick.watchOut)) : null,
      themeLink(theme),
    ),
  );
}

function readBlock(r: MatchResult, pending: boolean): HTMLElement {
  return h(
    "section",
    { class: `read${r.engine === "ai" ? " fade-in" : ""}`, "aria-labelledby": "read-label" },
    h("h2", { class: "read-label", id: "read-label" }, r.engine === "ai" ? "The read" : "Quick read"),
    h(
      "div",
      { class: "read-body" },
      h("p", { class: "read-text" }, r.read),
      pending ? h("div", { class: "read-pending", "aria-hidden": "true" }, h("span", { class: "skel" }), h("span", { class: "skel" }), h("span", { class: "skel skel-short" })) : null,
    ),
  );
}

function statusBar(base: MatchResult, id: number, status: Status): HTMLElement {
  if (status.kind === "working") {
    return h(
      "div",
      { class: "ai-status", "data-state": "working" },
      h("span", { class: "ai-dot", "aria-hidden": "true" }),
      h("p", { class: "ai-status-text" }, h("strong", {}, "AI is re-ranking all 29 themes. "), "The rule-based picks below hold until it lands."),
    );
  }
  if (status.kind === "done") {
    const note = status.savedAt ? savedLabel(status.savedAt) : `Re-ranked by ${status.result.model} in ${seconds(status.result.ms)}`;
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
    ". These rule-based picks are a solid start.",
  );
  const now = h("button", { type: "button", class: "btn-secondary btn-small" }, icon("retry"), "Try AI now");
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
    h(
      "ol",
      { class: `picks${status.kind === "working" ? " is-pending" : ""}${ai ? " fade-in" : ""}`, "aria-label": "Theme picks" },
      ...shown.picks.slice(0, 3).map(pickCard),
    ),
  );
}

function showAi(base: MatchResult, id: number, result: MatchResult, savedAt: string | null): void {
  results.querySelector(".read")?.replaceWith(readBlock(result, false));
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
    title: () => "This catalog isn't public",
    body: (d) => `${d} is either not on Shopify or keeps its product catalog private, so there is nothing to read. Try one of these stores instead.`,
    retry: false,
  },
  empty: {
    title: () => "No public products yet",
    body: (d) => `${d} is on Shopify but lists no public products, so there is nothing to match against. Try one of these stores instead.`,
    retry: false,
  },
  unreachable: {
    title: (d) => `We couldn't open ${d}`,
    body: () => "Check the spelling of the address and try again, or start from one of these stores.",
    retry: true,
  },
  network: {
    title: () => "You seem to be offline",
    body: () => "Fitting Room couldn't reach its server. Check your connection, then try again.",
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
  const retry = h("button", { type: "button", class: "btn-primary btn-small" }, "Try again");
  retry.addEventListener("click", () => void run(url));
  const examples = kind === "network" || kind === "server" ? [] : EXAMPLES.filter((e) => e.domain !== domain).slice(0, 3);
  results.replaceChildren(
    h(
      "div",
      { class: "error card", role: "alert", "data-kind": kind },
      h("h2", { class: "error-title" }, copy.title(domain)),
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
  if (!domain) return showHint("That doesn't look like a store address. Try something like deathwishcoffee.com.");
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
      return showHint("That doesn't look like a store address. Try something like deathwishcoffee.com.");
    }
    return showError(kind, domain ?? url, url);
  }
  if (id !== runId) return;
  clearTimers();
  setBusy(false);
  const saved = rules.engine === "ai" ? null : readSaved(rules.store.domain);
  const final = rules.engine === "ai" ? rules : saved;
  results.replaceChildren(storeCard(rules.store), readBlock(final ?? rules, !final), h("div", { class: "picks-zone" }));
  const next = new URLSearchParams(location.search);
  next.set("store", rules.store.domain || domainOf(url));
  history.replaceState(null, "", `?${next}`);
  results.querySelector<HTMLElement>("#store-name")?.focus({ preventScroll: true });
  if (final) return showAi(rules, id, final, final.cachedAt ?? null);
  announce(`${rules.store.name || rules.store.domain}: rule-based picks are ${themeNames(rules)}. AI is re-ranking.`);
  await refine(rules, id, true);
}

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
