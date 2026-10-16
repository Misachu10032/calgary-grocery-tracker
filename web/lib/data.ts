import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Category, Price, PriceHistoryEntry, Product, SiteData, Store, UnitBasis } from "./types";

const HISTORY_WEEKS = 6; // previous weeks shown in each item's price history

// Written by scripts/export_site_data.py from the local SQLite database and
// committed to git; pushing a new version makes GitHub Pages rebuild the site.
const DATA_FILE = path.join(process.cwd(), "data", "site-data.json");

// Product photos dropped into public/products/<slug>.<ext> are picked up at build time.
const IMAGE_DIR = path.join(process.cwd(), "public", "products");
const IMAGE_EXTENSIONS = [".webp", ".jpg", ".jpeg", ".png", ".avif"];
const localImages: Map<string, string> = (() => {
  try {
    return new Map(
      readdirSync(IMAGE_DIR)
        .filter((file) => IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase()))
        // Plain <img> tags don't get basePath added automatically (needed on GitHub Pages).
        .map((file) => [path.parse(file).name, `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/products/${file}`]),
    );
  } catch {
    return new Map();
  }
})();

type ProductRow = {
  id: number;
  slug: string;
  name_en: string;
  name_zh: string | null;
  unit_basis: UnitBasis;
  image_url: string | null;
};
type LatestPriceRow = Price & { product_id: number };
type WeeklyPriceRow = LatestPriceRow & { week_start: string };

/** Shape of web/data/site-data.json (see scripts/export_site_data.py). */
type ExportFile = {
  generated_at: string;
  products: ProductRow[];
  categories: (Category & { sort_order: number })[];
  product_categories: { product_id: number; category: string }[];
  stores: Store[];
  latest_prices: LatestPriceRow[];
  weekly_prices: WeeklyPriceRow[];
  runs: { store_id: string; finished_at: string | null }[];
};

const byUnitPrice = (a: Price, b: Price) =>
  (a.per_unit ?? Number.POSITIVE_INFINITY) - (b.per_unit ?? Number.POSITIVE_INFINITY) || a.price - b.price;

/** Monday (UTC date) of the week containing `date`, as "YYYY-MM-DD"; matches the export's weeks. */
function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Each product's lowest per-unit price in each previous week (across all stores),
 * newest first. The current week comes from latest_prices instead.
 */
function buildHistory(rows: WeeklyPriceRow[], currentWeek: string): Map<number, PriceHistoryEntry[]> {
  const best = new Map<number, Map<string, Price>>();
  for (const { week_start, product_id, ...price } of rows) {
    if (week_start >= currentWeek) continue;
    const weeks = best.get(product_id) ?? new Map<string, Price>();
    const current = weeks.get(week_start);
    if (!current || byUnitPrice(price, current) < 0) weeks.set(week_start, price);
    best.set(product_id, weeks);
  }
  const history = new Map<number, PriceHistoryEntry[]>();
  for (const [productId, weeks] of best) {
    history.set(
      productId,
      [...weeks.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, HISTORY_WEEKS)
        .map(([week, price]) => ({ week, price })),
    );
  }
  return history;
}

/**
 * Local preview only: `DEMO_HISTORY=1 npm run build` fakes three past weeks from the
 * current best prices so the price-history dropdown can be tried before real history
 * exists. Never set this in production.
 */
function demoHistory(products: Product[], currentWeek: string): Map<number, PriceHistoryEntry[]> {
  const factors = [1.08, 0.94, 1.15];
  const history = new Map<number, PriceHistoryEntry[]>();
  for (const p of products) {
    const entries: PriceHistoryEntry[] = [];
    factors.forEach((factor, i) => {
      const source = p.prices[i % Math.max(p.prices.length, 1)];
      if (!source) return;
      const start = new Date(`${currentWeek}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 7 * (i + 1));
      const week = start.toISOString().slice(0, 10);
      entries.push({
        week,
        price: {
          ...source,
          price: Math.round(source.price * factor * 100) / 100,
          per_unit: source.per_unit == null ? null : Math.round(source.per_unit * factor * 1000) / 1000,
          observed_on: week,
        },
      });
    });
    history.set(p.id, entries);
  }
  return history;
}

/**
 * Everything the page needs, read once at build time from the exported data file.
 * Dates are relative to when the data was exported, so the build is reproducible.
 */
export async function getSiteData(): Promise<SiteData> {
  const data = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as ExportFile;
  const now = new Date(data.generated_at);
  const currentWeek = mondayOf(now);

  // Only stores the collectors have actually checked can say "not found".
  const checkedStoreIds = new Set(data.runs.map((r) => r.store_id));
  const checkedStores = data.stores.filter((s) => checkedStoreIds.has(s.id));

  const categoriesByProduct = new Map<number, string[]>();
  for (const link of data.product_categories) {
    const list = categoriesByProduct.get(link.product_id) ?? [];
    list.push(link.category);
    categoriesByProduct.set(link.product_id, list);
  }

  const pricesByProduct = new Map<number, Price[]>();
  for (const { product_id, ...price } of data.latest_prices) {
    const list = pricesByProduct.get(product_id) ?? [];
    list.push(price);
    pricesByProduct.set(product_id, list);
  }

  const products: Product[] = data.products.map((p) => {
    const productPrices = (pricesByProduct.get(p.id) ?? []).sort(byUnitPrice);
    const foundAt = new Set(productPrices.map((price) => price.store_id));
    return {
      id: p.id,
      slug: p.slug,
      name_en: p.name_en,
      name_zh: p.name_zh,
      unit_basis: p.unit_basis,
      categories: categoriesByProduct.get(p.id) ?? [],
      image: p.image_url || localImages.get(p.slug) || null,
      prices: productPrices,
      missingStores: checkedStores.filter((s) => !foundAt.has(s.id)),
      history: [],
    };
  });

  const history =
    process.env.DEMO_HISTORY === "1" ? demoHistory(products, currentWeek) : buildHistory(data.weekly_prices, currentWeek);
  for (const p of products) p.history = history.get(p.id) ?? [];

  const usedCategories = new Set(products.flatMap((p) => p.categories));
  const lastUpdated = data.runs
    .map((r) => r.finished_at)
    .filter((t): t is string => Boolean(t))
    .sort()
    .at(-1);
  return {
    products,
    categories: data.categories
      .filter((c) => usedCategories.has(c.slug))
      .map(({ slug, name_en, name_zh }) => ({ slug, name_en, name_zh })),
    stores: checkedStores,
    lastUpdated: lastUpdated ?? null,
    builtAt: now.toISOString(),
  };
}
