/** Mock results for ?mock=1|noai|cached|error: the fast rule-based answer, the AI refinement, and a saved AI answer. */
import { THEMES } from "../lib/themes.ts";
import type { MatchResult, StoreProfile, Theme } from "../lib/types.ts";

const theme = (slug: string): Theme => {
  const found = THEMES.find((t) => t.slug === slug);
  if (!found) throw new Error(`fixture: no theme ${slug}`);
  return found;
};

const store: StoreProfile = {
  domain: "fernandfold.com",
  name: "Fern & Fold",
  description: "Small-batch linen bedding, towels and table goods, woven in Portugal.",
  currentTheme: { name: "Dawn", studio: null },
  productCount: 184,
  productCountCapped: false,
  priceMin: 18,
  priceMedian: 68,
  priceMax: 420,
  vendors: 3,
  topTypes: ["Bedding", "Bath", "Table Linen", "Gift Card"],
  avgVariants: 7.4,
  avgImages: 5.2,
  hasColorOptions: true,
  vertical: "home",
  sampleProducts: [
    { title: "Stonewashed Linen Duvet Cover", image: null, price: 240 },
    { title: "Waffle Bath Towel", image: null, price: 38 },
    { title: "Linen Napkins, Set of 4", image: null, price: 44 },
    { title: "Pillowcase Pair", image: null, price: 68 },
    { title: "Fitted Sheet", image: null, price: 120 },
    { title: "Gift Card", image: null, price: 50 },
  ],
};

const ruleWhy = (t: Theme) => `${t.tagline} Your store lists 184 products at a median of $68.`;
const ruleWatch = "Scored by rules, not AI. Preview it on your own products before buying.";

export const fixtureRules: MatchResult = {
  store,
  read: "Fern & Fold lists 184 products across 3 vendors, with a median price of $68.",
  picks: (["alchemy", "symmetry", "impulse"] as const).map((slug, i) => ({
    theme: theme(slug),
    fit: [81, 79, 76][i],
    why: ruleWhy(theme(slug)),
    watchOut: ruleWatch,
  })),
  engine: "rules",
  model: "rule-based scorer",
  ms: 1500,
};

export const fixture: MatchResult = {
  store,
  read:
    "Fern & Fold is a focused home-textiles brand running the free Dawn theme. 184 products across bedding, bath and table linen, a $68 median price, and an average of 7.4 variants per product, mostly color and size. The catalog is small enough to browse by hand but variant-heavy, so swatches, strong product imagery and a calm editorial layout matter more than mega menus or bulk ordering.",
  picks: [
    {
      theme: theme("impulse"),
      fit: 91,
      why: "Color swatches and quick buy handle the 7.4 variants per product without extra apps, and the shoppable hero suits a lifestyle-led linen brand with 5 images per product.",
      watchOut: "At $500 it is the priciest pick. Promotions features are strong, but a three-vendor brand may not use most of them.",
    },
    {
      theme: theme("symmetry"),
      fit: 86,
      why: "Clean, sectioned layouts fit a 184-product catalog, and its filtering keeps bedding, bath and table linen easy to separate without a mega menu.",
      watchOut: "Its default look leans toward fashion. Expect to tune typography to match the soft, natural tone of the brand.",
    },
    {
      theme: theme("turbo"),
      fit: 78,
      why: "Built for speed, which helps a catalog with heavy imagery, and its home page sections give room to tell the Portugal mill story.",
      watchOut: "Sold directly by Out of the Sandbox rather than the Shopify Theme Store, so installs and updates work a little differently.",
    },
  ],
  engine: "ai",
  model: "mock-model",
  ms: 5500,
};

export const fixtureCached: MatchResult = { ...fixture, cachedAt: "2026-11-26T17:00:00.000Z" };
