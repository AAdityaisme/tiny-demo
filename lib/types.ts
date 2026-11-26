/** Shared contract between api/match.ts and the page. */

export type Studio = "Pixel Union" | "Archetype Themes" | "Clean Canvas" | "Out of the Sandbox";

export interface Theme {
  slug: string;
  name: string;
  studio: Studio;
  price: number;
  tagline: string;
  rating: number | null;
  highlights: string;
  features: string;
  url: string;
  image: string | null;
  /** Verticals the theme is built for; empty means a generalist theme. */
  verticals: Vertical[];
  /** Catalog sizes the theme suits. */
  catalog: CatalogSize[];
}

export type Vertical = "apparel" | "beauty" | "food-drink" | "wine-spirits" | "home" | "jewelry" | "electronics" | "sports-outdoor" | "health" | "kids-pets" | "art-media";
export type CatalogSize = "single" | "small" | "medium" | "large";

export interface StoreProfile {
  domain: string;
  name: string;
  description: string;
  currentTheme: { name: string; studio: Studio | null } | null;
  productCount: number;
  productCountCapped: boolean;
  priceMin: number;
  priceMedian: number;
  priceMax: number;
  vendors: number;
  topTypes: string[];
  avgVariants: number;
  avgImages: number;
  hasColorOptions: boolean;
  /** Best-guess vertical from product types, tags and titles; null when unclear. */
  vertical: Vertical | null;
  sampleProducts: { title: string; image: string | null; price: number }[];
}

export interface Pick {
  theme: Theme;
  fit: number;
  why: string;
  watchOut: string;
}

export interface MatchResult {
  store: StoreProfile;
  read: string;
  picks: Pick[];
  engine: "ai" | "rules";
  model: string;
  ms: number;
  /** Set when the AI picks were served from a snapshot or the server cache instead of computed now (ISO time). */
  cachedAt?: string;
}

/** Why a store couldn't be read, so the page can pick its copy without parsing messages. */
export type FailureCode = "invalid" | "unreachable" | "not-shopify" | "empty";

export interface MatchError {
  error: string;
  code?: FailureCode;
  /** On 429 from /api/refine: seconds until the server's AI lane is free again. */
  retryAfterSec?: number;
}
