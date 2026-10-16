import { readdirSync } from "node:fs";
import path from "node:path";
import { cacheLife } from "next/cache";
import type { Category, HistoryWeek, Price, Product, SiteData, Store, UnitBasis } from "./types";

const HISTORY_WEEKS = 8; // previous weeks offered in the week picker

// Product photos dropped into public/products/<slug>.<ext> are picked up at build time.
const IMAGE_DIR = path.join(process.cwd(), "public", "products");
const IMAGE_EXTENSIONS = [".webp", ".jpg", ".jpeg", ".png", ".avif"];
const localImages: Map<string, string> = (() => {
  try {
    return new Map(
      readdirSync(IMAGE_DIR)
        .filter((file) => IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase()))
        .map((file) => [path.parse(file).name, `/products/${file}`]),
    );
  } catch {
    return new Map();
  }
})();

async function query<T>(pathAndQuery: string): Promise<T> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL and SUPABASE_ANON_KEY (read-only publishable key).");
  }
  const headers: Record<string, string> = { apikey: key };
  // Legacy anon keys are JWTs and also go in Authorization; publishable keys must not.
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  // no-store: every build must read fresh prices. `use cache` on getSiteData still
  // makes the page static; without this, rebuilds could reuse last week's fetch cache.
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, { headers, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Supabase ${pathAndQuery.split("?")[0]}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

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
type RunRow = { store_id: string | null; finished_at: string | null };

const byUnitPrice = (a: Price, b: Price) =>
  (a.per_unit ?? Number.POSITIVE_INFINITY) - (b.per_unit ?? Number.POSITIVE_INFINITY) || a.price - b.price;

/** Monday (UTC date) of the week containing `date`, as "YYYY-MM-DD". Matches Postgres date_trunc('week'). */
function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Previous weeks' best prices, newest first (the current week comes from latest_prices). */
function buildHistory(rows: WeeklyPriceRow[], currentWeek: string): HistoryWeek[] {
  const weeks = new Map<string, Record<string, Price[]>>();
  for (const { week_start, product_id, ...price } of rows) {
    if (week_start >= currentWeek) continue;
    const week = weeks.get(week_start) ?? {};
    (week[product_id] ??= []).push(price);
    weeks.set(week_start, week);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, HISTORY_WEEKS)
    .map(([start, pricesByProduct]) => {
      for (const list of Object.values(pricesByProduct)) list.sort(byUnitPrice);
      return { start, pricesByProduct };
    });
}

/**
 * Local preview only: `DEMO_HISTORY=1 npm run build` fakes two past weeks from the
 * current prices (±10%) so the week picker can be tried before real history exists.
 * Never set this in production.
 */
function demoHistory(products: Product[], currentWeek: string): HistoryWeek[] {
  return [1, 2].map((weeksAgo) => {
    const start = new Date(`${currentWeek}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 7 * weeksAgo);
    const startText = start.toISOString().slice(0, 10);
    const factor = weeksAgo === 1 ? 1.08 : 0.94;
    const pricesByProduct: Record<string, Price[]> = {};
    for (const p of products) {
      pricesByProduct[p.id] = p.prices.slice(0, weeksAgo === 1 ? undefined : 2).map((x) => ({
        ...x,
        price: Math.round(x.price * factor * 100) / 100,
        per_unit: x.per_unit == null ? null : Math.round(x.per_unit * factor * 1000) / 1000,
        observed_on: startText,
        valid_to: null,
      }));
    }
    return { start: startText, pricesByProduct };
  });
}

/** Everything the page needs, fetched once per build (7 small requests). */
export async function getSiteData(): Promise<SiteData> {
  "use cache";
  cacheLife("weeks");

  const now = new Date();
  const currentWeek = mondayOf(now);
  const historyFrom = mondayOf(new Date(now.getTime() - HISTORY_WEEKS * 7 * 86_400_000));

  const [productRows, categories, links, stores, prices, runs, weekly] = await Promise.all([
    query<ProductRow[]>("products?select=id,slug,name_en,name_zh,unit_basis,image_url&order=id"),
    query<(Category & { sort_order: number })[]>(
      "categories?select=slug,name_en,name_zh,sort_order&order=sort_order",
    ),
    query<{ product_id: number; categories: { slug: string } }[]>(
      "product_categories?select=product_id,categories(slug)",
    ),
    query<Store[]>("stores?select=id,chain,name,website&order=chain"),
    query<LatestPriceRow[]>("latest_prices?select=*"),
    query<RunRow[]>("scrape_runs?select=store_id,finished_at&status=eq.ok&order=finished_at.desc&limit=500"),
    query<WeeklyPriceRow[]>(
      `weekly_prices?select=*&week_start=gte.${historyFrom}&week_start=lt.${currentWeek}&order=week_start.desc`,
    ),
  ]);

  // Only stores the collector has actually checked can say "not found".
  const checkedStoreIds = new Set(runs.map((r) => r.store_id).filter(Boolean));
  const checkedStores = stores.filter((s) => checkedStoreIds.has(s.id));

  const categoriesByProduct = new Map<number, string[]>();
  for (const link of links) {
    const list = categoriesByProduct.get(link.product_id) ?? [];
    list.push(link.categories.slug);
    categoriesByProduct.set(link.product_id, list);
  }

  const pricesByProduct = new Map<number, Price[]>();
  for (const { product_id, ...price } of prices) {
    const list = pricesByProduct.get(product_id) ?? [];
    list.push(price);
    pricesByProduct.set(product_id, list);
  }

  const products: Product[] = productRows.map((p) => {
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
    };
  });

  const usedCategories = new Set(products.flatMap((p) => p.categories));
  return {
    products,
    categories: categories
      .filter((c) => usedCategories.has(c.slug))
      .map(({ slug, name_en, name_zh }) => ({ slug, name_en, name_zh })),
    stores: checkedStores,
    history:
      process.env.DEMO_HISTORY === "1" ? demoHistory(products, currentWeek) : buildHistory(weekly, currentWeek),
    lastUpdated: runs.find((r) => r.finished_at)?.finished_at ?? null,
    builtAt: now.toISOString(),
  };
}
