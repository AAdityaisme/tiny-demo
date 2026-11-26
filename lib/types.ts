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
}

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
}

export interface MatchError {
  error: string;
}
