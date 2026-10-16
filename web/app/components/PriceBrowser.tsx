"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  containerText,
  daysBetween,
  displayValue,
  money,
  perUnitText,
  shelfPriceText,
  shortDate,
  sourceLabel,
  unitLabel,
  weekLabel,
} from "@/lib/format";
import type { HistoryWeek, Price, Product, SiteData, Store, WeightUnit } from "@/lib/types";
import { BasketIcon, ChevronDownIcon, ClockIcon, ExternalIcon, HistoryIcon, SearchIcon, TagIcon } from "./Icons";
import { ProductImage } from "./ProductImage";

const VISIBLE_PRICES = 3;
const STALE_AFTER_DAYS = 10;
const WEIGHT_UNITS: { value: WeightUnit; label: string }[] = [
  { value: "100g", label: "100 g" },
  { value: "lb", label: "lb" },
  { value: "kg", label: "kg" },
];

// The visitor's weight unit, remembered in localStorage (best effort: storage may be
// unavailable, and the server-rendered page always starts at per 100 g).
const WEIGHT_UNIT_KEY = "weight-unit";
const WEIGHT_UNIT_EVENT = "weight-unit-change";

function readWeightUnit(): WeightUnit {
  try {
    const saved = localStorage.getItem(WEIGHT_UNIT_KEY);
    if (saved === "100g" || saved === "lb" || saved === "kg") return saved;
  } catch {}
  return "100g";
}

function subscribeWeightUnit(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(WEIGHT_UNIT_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(WEIGHT_UNIT_EVENT, onChange);
  };
}

function saveWeightUnit(unit: WeightUnit) {
  try {
    localStorage.setItem(WEIGHT_UNIT_KEY, unit);
  } catch {}
  window.dispatchEvent(new Event(WEIGHT_UNIT_EVENT));
}

const CURRENT_WEEK = "current";

export function PriceBrowser({ data }: { data: SiteData }) {
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [week, setWeek] = useState<string>(CURRENT_WEEK);
  const weightUnit = useSyncExternalStore(subscribeWeightUnit, readWeightUnit, () => "100g" as WeightUnit);
  const chooseWeightUnit = saveWeightUnit;

  // A past week swaps in that week's prices; products and categories stay the same.
  const historyWeek = data.history.find((h) => h.start === week) ?? null;
  const products = useMemo(() => {
    if (!historyWeek) return data.products;
    return data.products.map((p) => {
      const prices = historyWeek.pricesByProduct[p.id] ?? [];
      const foundAt = new Set(prices.map((x) => x.store_id));
      return { ...p, prices, missingStores: data.stores.filter((s) => !foundAt.has(s.id)) };
    });
  }, [data.products, data.stores, historyWeek]);

  const storesById = useMemo(() => new Map(data.stores.map((s) => [s.id, s])), [data.stores]);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const p of data.products) for (const c of p.categories) result.set(c, (result.get(c) ?? 0) + 1);
    return result;
  }, [data.products]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (category !== "all" && !p.categories.includes(category)) return false;
      if (!q) return true;
      const haystack = [p.name_en, p.slug, ...p.prices.map((x) => x.item_name)].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [products, category, query]);

  // "All" without a search shows one section per category; otherwise a single grid.
  const sections = useMemo(() => {
    if (category !== "all" || query.trim()) return [{ key: "results", title: null as string | null, products: visible }];
    return data.categories
      .map((c) => ({ key: c.slug, title: c.name_en, products: visible.filter((p) => p.categories[0] === c.slug) }))
      .filter((s) => s.products.length > 0);
  }, [category, query, visible, data.categories]);

  const showWeightToggle = visible.some((p) => p.unit_basis === "100g");
  const foundCount = data.products.filter((p) => p.prices.length > 0).length;

  return (
    <div className="min-h-full bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="sticky top-0 z-20 border-b border-black/5 bg-white/75 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/75">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/30">
              <BasketIcon className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <p className="text-[15px] font-semibold tracking-tight">YYC Grocery Compare</p>
              <p className="text-xs text-neutral-500">Calgary · weekly price check</p>
            </div>
          </div>
          {data.lastUpdated && (
            <p className="hidden items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 text-xs text-neutral-600 sm:flex dark:bg-white/5 dark:text-neutral-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Updated {shortDate(data.lastUpdated)} · {data.stores.length} stores
            </p>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <section className="pb-8 pt-12 sm:pt-16">
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-5xl">
            Find the cheapest groceries in Calgary.
          </h1>
          <p className="mt-4 max-w-xl text-base text-neutral-600 sm:text-lg dark:text-neutral-400">
            {data.products.length} everyday items compared across {data.stores.length} stores by unit price, from
            this week&apos;s flyers and store websites.
          </p>
          <label className="relative mt-8 block max-w-xl">
            <span className="sr-only">Search items</span>
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chicken, bananas, Monster…"
              className="w-full rounded-2xl border border-black/5 bg-white py-3.5 pl-12 pr-4 text-[15px] shadow-sm outline-none ring-emerald-500/30 transition placeholder:text-neutral-400 focus:border-emerald-500/50 focus:ring-4 dark:border-white/10 dark:bg-neutral-900"
            />
          </label>
        </section>

        <nav
          aria-label="Categories"
          className="sticky top-[61px] z-10 -mx-4 mb-8 flex flex-col gap-3 bg-neutral-50/85 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:bg-neutral-950/85"
        >
          <div className="flex min-w-0 gap-2 overflow-x-auto [scrollbar-width:none]">
            <CategoryPill active={category === "all"} onClick={() => setCategory("all")} label="All" count={data.products.length} />
            {data.categories.map((c) => (
              <CategoryPill
                key={c.slug}
                active={category === c.slug}
                onClick={() => setCategory(c.slug)}
                label={c.name_en}
                count={counts.get(c.slug) ?? 0}
              />
            ))}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
            <WeekPicker history={data.history} value={week} onChange={setWeek} />
            {showWeightToggle && <WeightToggle value={weightUnit} onChange={chooseWeightUnit} />}
          </div>
        </nav>

        {historyWeek && (
          <div className="mb-8 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            <p className="flex items-center gap-2">
              <HistoryIcon className="h-4 w-4 shrink-0" />
              <span>
                Showing prices from <strong>{weekLabel(historyWeek.start)}</strong>. These prices may have changed.
              </span>
            </p>
            <button
              type="button"
              onClick={() => setWeek(CURRENT_WEEK)}
              className="self-start rounded-full bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-800 sm:self-auto dark:bg-amber-200 dark:text-amber-950"
            >
              Back to this week
            </button>
          </div>
        )}

        {visible.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-neutral-300 p-12 text-center text-neutral-500 dark:border-neutral-700">
            No items match “{query}”.
          </div>
        ) : (
          sections.map((section) => (
            <section key={section.key} className="mb-12">
              {section.title && (
                <h2 className="mb-4 flex items-baseline gap-2 text-xl font-semibold tracking-tight">
                  {section.title}
                  <span className="text-sm font-normal text-neutral-400">{section.products.length}</span>
                </h2>
              )}
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {section.products.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    storesById={storesById}
                    builtAt={data.builtAt}
                    weightUnit={weightUnit}
                    isHistory={historyWeek !== null}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </main>

      <footer className="border-t border-black/5 py-10 text-center text-xs leading-relaxed text-neutral-500 dark:border-white/10">
        <p>
          Prices are collected automatically from flyers and store websites and may change. Please confirm in store.
        </p>
        <p className="mt-1">
          {foundCount} of {data.products.length} items found this week
          {data.lastUpdated ? ` · last checked ${shortDate(data.lastUpdated)}` : ""}.
        </p>
        {data.history.length === 0 && (
          <p className="mt-1">Price history starts building with each weekly update; past weeks will appear in the week picker.</p>
        )}
      </footer>
    </div>
  );
}

function CategoryPill({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
        active
          ? "bg-neutral-900 text-white shadow-sm dark:bg-white dark:text-neutral-900"
          : "bg-white text-neutral-700 ring-1 ring-black/5 hover:bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-white/10 dark:hover:bg-neutral-800"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 text-[11px] tabular-nums ${
          active ? "bg-white/20 dark:bg-black/10" : "bg-neutral-100 text-neutral-500 dark:bg-white/5"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

/** "This week" plus a dropdown of past weeks; a disabled placeholder until history exists. */
function WeekPicker({
  history,
  value,
  onChange,
}: {
  history: HistoryWeek[];
  value: string;
  onChange: (week: string) => void;
}) {
  const isCurrent = value === CURRENT_WEEK;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-neutral-500">Week</span>
      <div role="group" aria-label="Week" className="flex items-center rounded-full bg-white p-1 ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10">
        <button
          type="button"
          aria-pressed={isCurrent}
          onClick={() => onChange(CURRENT_WEEK)}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
            isCurrent
              ? "bg-neutral-900 text-white shadow-sm dark:bg-white dark:text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
          }`}
        >
          This week
        </button>
        {history.length > 0 ? (
          <label className="relative">
            <span className="sr-only">Past weeks</span>
            <select
              value={isCurrent ? "" : value}
              onChange={(e) => onChange(e.target.value)}
              className={`cursor-pointer appearance-none rounded-full py-1 pl-3 pr-7 text-xs font-semibold outline-none transition ${
                isCurrent
                  ? "bg-transparent text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
                  : "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
              }`}
            >
              <option value="" disabled>
                Past weeks
              </option>
              {history.map((h) => (
                <option key={h.start} value={h.start}>
                  {weekLabel(h.start)}
                </option>
              ))}
            </select>
            <ChevronDownIcon
              className={`pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 ${isCurrent ? "text-neutral-400" : "text-white dark:text-neutral-900"}`}
            />
          </label>
        ) : (
          <span
            title="Past weeks appear here after the next weekly price update."
            aria-disabled="true"
            className="flex cursor-not-allowed items-center gap-1 px-3 py-1 text-xs font-medium text-neutral-400"
          >
            <HistoryIcon className="h-3.5 w-3.5" />
            Past weeks · soon
          </span>
        )}
      </div>
    </div>
  );
}

function WeightToggle({ value, onChange }: { value: WeightUnit; onChange: (unit: WeightUnit) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
      <span className="text-xs font-medium text-neutral-500">Price per</span>
      <div role="radiogroup" aria-label="Weight unit" className="flex rounded-full bg-white p-1 ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10">
        {WEIGHT_UNITS.map((unit) => (
          <button
            key={unit.value}
            type="button"
            role="radio"
            aria-checked={value === unit.value}
            onClick={() => onChange(unit.value)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              value === unit.value
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
            }`}
          >
            {unit.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProductCard({
  product,
  storesById,
  builtAt,
  weightUnit,
  isHistory,
}: {
  product: Product;
  storesById: Map<string, Store>;
  builtAt: string;
  weightUnit: WeightUnit;
  isHistory: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const best = product.prices.find((p) => p.per_unit != null) ?? null;
  const shown = expanded ? product.prices : product.prices.slice(0, VISIBLE_PRICES);
  const hidden = product.prices.length - shown.length;

  return (
    <article className="group flex flex-col rounded-3xl border border-black/5 bg-white p-3 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 dark:border-white/10 dark:bg-neutral-900 dark:hover:shadow-black/40">
      <ProductImage src={product.image} alt={product.name_en} category={product.categories[0]} />

      <div className="flex flex-1 flex-col px-2 pb-2 pt-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-lg font-semibold leading-snug tracking-tight">{product.name_en}</h3>
          {best && best.per_unit != null && (
            <div className="shrink-0 rounded-2xl bg-emerald-50 px-3 py-2 text-right dark:bg-emerald-500/10">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                Best
              </p>
              <p className="text-lg font-semibold leading-tight text-emerald-700 dark:text-emerald-300">
                {money(displayValue(best.per_unit, best.unit_basis, weightUnit))}
              </p>
              <p className="text-[11px] text-emerald-700/70 dark:text-emerald-400/70">
                {unitLabel(best.unit_basis, weightUnit)}
              </p>
            </div>
          )}
        </div>

        {product.prices.length === 0 ? (
          <div className="mt-4 flex flex-1 items-center justify-center rounded-2xl bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500 dark:bg-white/5">
            {isHistory ? "No prices recorded for this week." : "Not found in this week's flyers or store websites."}
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-black/5 dark:divide-white/10">
            {shown.map((price, i) => (
              <PriceRow
                key={`${price.store_id}-${i}`}
                price={price}
                isBest={price === best}
                fallbackUrl={storesById.get(price.store_id)?.website ?? null}
                builtAt={builtAt}
                weightUnit={weightUnit}
                isHistory={isHistory}
              />
            ))}
          </ul>
        )}

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-1 self-start rounded-full px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/10"
          >
            Show {hidden} more store{hidden > 1 ? "s" : ""}
          </button>
        )}

        {product.missingStores.length > 0 && (
          <p className="mt-auto pt-3 text-xs leading-relaxed text-neutral-400">
            Not found at {product.missingStores.map((s) => s.chain).join(", ")}
          </p>
        )}
      </div>
    </article>
  );
}

function PriceRow({
  price,
  isBest,
  fallbackUrl,
  builtAt,
  weightUnit,
  isHistory,
}: {
  price: Price;
  isBest: boolean;
  fallbackUrl: string | null;
  builtAt: string;
  weightUnit: WeightUnit;
  isHistory: boolean;
}) {
  const perUnit = perUnitText(price, weightUnit);
  const container = price.unit_basis === "container" ? containerText(price) : null;
  const detail = container ? `${container} · ${money(price.price)}` : shelfPriceText(price);
  const href = price.url ?? fallbackUrl;
  // Past weeks are old by definition; only flag stale prices in the current view.
  const stale = !isHistory && daysBetween(price.observed_on, builtAt) > STALE_AFTER_DAYS;
  const membersOnly = /member/i.test(price.conditions ?? "") && !/more rewards members:/i.test(price.conditions ?? "");

  return (
    <li className={`flex gap-3 py-3 ${stale ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold">{price.chain}</p>
          {isBest && (
            <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              Cheapest
            </span>
          )}
        </div>
        <p className="truncate text-xs text-neutral-500" title={price.item_name}>
          {price.item_name}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Chip tone={price.source === "flipp" ? "amber" : "sky"}>{sourceLabel(price.source)}</Chip>
          {membersOnly && <Chip tone="rose">Members only</Chip>}
          {price.valid_to && (
            <Chip tone="neutral" icon={<TagIcon className="h-3 w-3" />}>
              Until {shortDate(price.valid_to)}
            </Chip>
          )}
          <Chip tone={stale ? "rose" : "neutral"} icon={<ClockIcon className="h-3 w-3" />}>
            {stale ? "May be outdated · " : "Checked "}
            {shortDate(price.observed_on)}
          </Chip>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end justify-between gap-1 text-right">
        <div>
          <p className="text-sm font-semibold tabular-nums">{perUnit ?? shelfPriceText(price)}</p>
          {perUnit && <p className="text-xs tabular-nums text-neutral-500">{detail}</p>}
        </div>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
          >
            {price.url ? "View" : "Store"}
            <ExternalIcon className="h-3 w-3" />
          </a>
        )}
      </div>
    </li>
  );
}

const CHIP_TONES = {
  amber: "bg-amber-50 text-amber-700 ring-amber-600/10 dark:bg-amber-500/10 dark:text-amber-300",
  sky: "bg-sky-50 text-sky-700 ring-sky-600/10 dark:bg-sky-500/10 dark:text-sky-300",
  rose: "bg-rose-50 text-rose-700 ring-rose-600/10 dark:bg-rose-500/10 dark:text-rose-300",
  neutral: "bg-neutral-100 text-neutral-600 ring-black/5 dark:bg-white/5 dark:text-neutral-400",
} as const;

function Chip({
  tone,
  icon,
  children,
}: {
  tone: keyof typeof CHIP_TONES;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${CHIP_TONES[tone]}`}>
      {icon}
      {children}
    </span>
  );
}
