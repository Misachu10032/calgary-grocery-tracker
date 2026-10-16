export type UnitBasis = "100g" | "100ml" | "each" | "container";

/** How weight-based prices (unit_basis 100g) are shown; chosen by the visitor. */
export type WeightUnit = "100g" | "lb" | "kg";

export type Store = {
  id: string;
  chain: string;
  name: string;
  website: string | null;
};

export type Category = {
  slug: string;
  name_en: string;
  name_zh: string | null;
};

export type Price = {
  store_id: string;
  chain: string;
  store_name: string;
  item_name: string;
  price: number;
  price_unit: string | null;
  regular_price: number | null;
  is_sale: boolean;
  per_unit: number | null;
  per_unit_max: number | null;
  unit_basis: UnitBasis | null;
  conditions: string | null;
  valid_from: string | null;
  valid_to: string | null;
  url: string | null;
  source: "website" | "flipp" | "manual";
  observed_on: string;
  pack_count: number | null; // containers in the pack (unit_basis container)
  container_size: number | null; // size of one container, e.g. 473
  container_unit: "ml" | "g" | null;
};

export type Product = {
  id: number;
  slug: string;
  name_en: string;
  name_zh: string | null;
  unit_basis: UnitBasis;
  categories: string[];
  image: string | null;
  prices: Price[]; // cheapest per unit first; rows without a per-unit price last
  missingStores: Store[]; // checked stores where this item was not found
  history: PriceHistoryEntry[]; // previous weeks' lowest price, newest first; empty until history builds up
};

/** The lowest per-unit price of a product in one past week, and where it was. */
export type PriceHistoryEntry = {
  week: string; // Monday of that week, "2026-10-05"
  price: Price;
};

export type SiteData = {
  products: Product[];
  categories: Category[];
  stores: Store[];
  lastUpdated: string | null; // ISO timestamp of the latest collector run
  builtAt: string; // ISO timestamp of this build
};
