/**
 * Fitting Room page. Step 1: POST /api/match returns the store profile and rule-based picks fast.
 * Step 2: the browser asks the AI to re-rank (the free AI tier rate-limits per IP, so it can't run on the server).
 * All API and AI text goes into the DOM through textContent.
 */
import { AiUnavailable, refineWithAi } from "../lib/match.ts";
import { THEMES } from "../lib/themes.ts";
import type { MatchError, MatchResult, Pick, StoreProfile, Theme } from "../lib/types.ts";

type PicksState = "pending" | "ai" | "failed";

// The Theme Store serves one generic share image for every theme, so it says nothing about the theme.
const GENERIC_IMAGE = "theme-store-social";
const FALLBACK_RETRY_SEC = 10;

const form = document.querySelector<HTMLFormElement>("#match-form")!;
const input = document.querySelector<HTMLInputElement>("#store-url")!;
const submitBtn = document.querySelector<HTMLButtonElement>("#submit-btn")!;
const hint = document.querySelector<HTMLParagraphElement>("#form-hint")!;
const chips = Array.from(document.querySelectorAll<HTMLButtonElement>(".chip"));
const results = document.querySelector<HTMLElement>("#results")!;
const params = new URLSearchParams(location.search);
const mock = params.get("mock");

let runId = 0;
let retryTimer = 0;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const httpUrl = (u: string | null | undefined): string | null =>
  u && /^https?:\/\//i.test(u) ? u : null;

const money = (n: number): string => {
  const cents = n < 100 && n % 1 ? 2 : 0;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: cents, maximumFractionDigits: cents });
};

const domainOf = (raw: string): string =>
  raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function setBusy(busy: boolean): void {
  submitBtn.disabled = busy;
  input.disabled = busy;
  for (const c of chips) c.disabled = busy;
  submitBtn.textContent = busy ? "Reading store" : "Find my theme";
  results.setAttribute("aria-busy", String(busy));
}

function stages(labels: string[], delays: number[]): { el: HTMLOListElement; stop: () => void } {
  const items = labels.map((l) => h("li", { class: "stage" }, h("span", { class: "stage-dot", "aria-hidden": "true" }), l));
  const mark = (active: number) =>
    items.forEach((li, i) => {
      li.classList.toggle("is-done", i < active);
      li.classList.toggle("is-active", i === active);
      if (i === active) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  const timers = delays.map((d, i) => window.setTimeout(() => mark(i), d));
  return { el: h("ol", { class: "stages" }, ...items), stop: () => timers.forEach(clearTimeout) };
}

function showReading(domain: string): () => void {
  const s = stages(["Reading catalog", "Detecting current theme"], [0, 1200]);
  results.replaceChildren(
    h("div", { class: "progress card" }, h("p", { class: "eyebrow" }, "Fitting ", h("strong", {}, domain)), s.el),
  );
  return s.stop;
}

async function fetchRules(url: string): Promise<MatchResult> {
  if (mock) {
    await sleep(1500);
    return (await import("./fixture.ts")).fixtureRules;
  }
  let res: Response;
  try {
    res = await fetch("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as MatchResult | MatchError | null;
  if (!res.ok || !body || "error" in body) {
    throw new Error(body && "error" in body && body.error ? body.error : `The server returned ${res.status}. Try again in a moment.`);
  }
  return body;
}

async function fetchAi(base: MatchResult): Promise<MatchResult> {
  if (mock) {
    await sleep(4000);
    if (mock === "noai") throw new AiUnavailable("The free AI tier allows one reply every 45 seconds per visitor.", 8);
    return (await import("./fixture.ts")).fixture;
  }
  return refineWithAi(base, THEMES);
}

function themeBadge(store: StoreProfile): HTMLElement {
  const t = store.currentTheme;
  if (!t) return h("p", { class: "badge badge-muted" }, "Theme not detected");
  if (t.studio) return h("p", { class: "badge badge-tiny" }, `Already on a Tiny studio theme: ${t.name} by ${t.studio}`);
  return h("p", { class: "badge" }, `On ${t.name}`);
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
  return h(
    "article",
    { class: "store card", "aria-labelledby": "store-name" },
    h(
      "div",
      { class: "store-head" },
      h(
        "div",
        {},
        h("p", { class: "eyebrow" }, "Your store"),
        h("h2", { id: "store-name", tabindex: "-1" }, store.name || store.domain),
        h("a", { class: "store-domain", href: `https://${domainOf(store.domain)}`, target: "_blank", rel: "noopener" }, store.domain),
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

function pickCard(pick: Pick, i: number): HTMLElement {
  const { theme } = pick;
  const link = httpUrl(theme.url);
  return h(
    "li",
    { class: "pick card" },
    h("div", { class: "pick-media" }, themeMedia(theme), h("span", { class: "pick-rank" }, `0${i + 1}`)),
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
      pick.watchOut
        ? h("div", { class: "watch" }, h("p", { class: "watch-label" }, "Watch out"), h("p", {}, pick.watchOut))
        : null,
      link
        ? h(
            "a",
            { class: "pick-link", href: link, target: "_blank", rel: "noopener" },
            "View theme",
            h("span", { class: "visually-hidden" }, ` ${theme.name} (opens in a new tab)`),
            h("span", { "aria-hidden": "true" }, " ↗"),
          )
        : null,
    ),
  );
}

function readBlock(r: MatchResult, fade: boolean): HTMLElement {
  return h(
    "div",
    { class: fade ? "read fade-in" : "read" },
    h("p", { class: "eyebrow" }, r.engine === "ai" ? "The read" : "Quick read"),
    h("p", { class: "read-text" }, r.read),
  );
}

function engineLine(r: MatchResult, state: PicksState): HTMLElement {
  if (state === "ai") return h("p", { class: "engine" }, `Matched by ${r.model} in ${seconds(r.ms)}`);
  if (state === "failed") return h("p", { class: "engine engine-fallback" }, `AI unavailable, rule-based fallback · ${seconds(r.ms)}`);
  return h("p", { class: "engine" }, `Rule-based picks in ${seconds(r.ms)}`);
}

function retryButton(base: MatchResult, id: number, waitSec: number): HTMLButtonElement {
  const btn = h("button", { type: "button", class: "btn-secondary", "aria-live": "off", disabled: "" });
  let left = Math.max(0, Math.ceil(waitSec));
  const tick = () => {
    if (left <= 0) {
      clearInterval(retryTimer);
      btn.disabled = false;
      btn.textContent = "Try AI again";
      return;
    }
    btn.textContent = `Try AI again in ${left}s`;
    left -= 1;
  };
  clearInterval(retryTimer);
  tick();
  retryTimer = window.setInterval(tick, 1000);
  btn.addEventListener("click", () => void refine(base, id));
  return btn;
}

function renderPicks(zone: HTMLElement, r: MatchResult, state: PicksState, extra: Node | null): void {
  const label = state === "ai" ? "AI picks" : "Rule-based picks";
  zone.replaceChildren(
    h(
      "div",
      { class: "picks-head" },
      h("h2", { class: "picks-title" }, "Three themes that fit"),
      h("span", { class: state === "ai" ? "engine-pill engine-pill-ai" : "engine-pill" }, label),
    ),
    extra ?? "",
    h(
      "ol",
      { class: `picks${state === "pending" ? " is-pending" : ""}${state === "ai" ? " fade-in" : ""}` },
      ...r.picks.slice(0, 3).map(pickCard),
    ),
    engineLine(r, state),
  );
}

async function refine(base: MatchResult, id: number): Promise<void> {
  const zone = results.querySelector<HTMLElement>(".picks-zone");
  const read = results.querySelector<HTMLElement>(".read");
  if (!zone || !read) return;
  clearInterval(retryTimer);
  const s = stages(["Comparing 29 themes", "Writing the fit notes"], [0, 6000]);
  renderPicks(
    zone,
    base,
    "pending",
    h(
      "div",
      { class: "ai-status" },
      h("p", { class: "ai-status-title" }, "AI is re-ranking all 29 themes against this store"),
      s.el,
      h("p", { class: "progress-note" }, "Usually 5 to 30 seconds. The rule-based picks below hold until it lands."),
    ),
  );
  try {
    const ai = await fetchAi(base);
    if (id !== runId) return;
    read.replaceWith(readBlock(ai, true));
    renderPicks(zone, ai, "ai", null);
  } catch (e) {
    if (id !== runId) return;
    const unavailable = e instanceof AiUnavailable;
    const message = unavailable ? e.message : "The AI request did not finish, so these are the rule-based picks.";
    renderPicks(
      zone,
      base,
      "failed",
      h(
        "div",
        { class: "ai-status ai-status-failed" },
        h("p", { class: "ai-status-title" }, message),
        retryButton(base, id, unavailable ? e.retryAfterSec : FALLBACK_RETRY_SEC),
      ),
    );
  } finally {
    s.stop();
  }
}

function showError(message: string, url: string): void {
  const retry = h("button", { type: "button", class: "btn-secondary" }, "Try again");
  retry.addEventListener("click", () => void run(url));
  results.replaceChildren(
    h("div", { class: "error card", role: "alert" }, h("p", { class: "error-title" }, "We could not fit that store"), h("p", {}, message), retry),
  );
}

async function run(raw: string): Promise<void> {
  const url = raw.trim();
  if (!url) {
    hint.textContent = "Enter a store address, like allbirds.com.";
    hint.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", "form-hint");
    input.focus();
    return;
  }
  const id = ++runId;
  clearInterval(retryTimer);
  hint.hidden = true;
  input.removeAttribute("aria-invalid");
  input.value = url;
  setBusy(true);
  const stop = showReading(domainOf(url));
  results.scrollIntoView({ behavior: "smooth", block: "start" });
  let rules: MatchResult;
  try {
    rules = await fetchRules(url);
  } catch (e) {
    stop();
    showError(e instanceof Error ? e.message : "Something went wrong.", url);
    setBusy(false);
    return;
  }
  stop();
  setBusy(false);
  results.replaceChildren(storeCard(rules.store), readBlock(rules, false), h("div", { class: "picks-zone" }));
  const next = new URLSearchParams(location.search);
  next.set("store", rules.store.domain || domainOf(url));
  history.replaceState(null, "", `?${next}`);
  results.querySelector<HTMLElement>("#store-name")?.focus({ preventScroll: true });
  await refine(rules, id);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void run(input.value);
});

for (const chip of chips) {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.store ?? "";
    void run(input.value);
  });
}

const initial = params.get("store");
if (initial) {
  input.value = initial;
  void run(initial);
}
