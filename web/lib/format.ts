import type { Price, UnitBasis, WeightUnit } from "./types";

const TIME_ZONE = "America/Edmonton";
const GRAMS_PER_LB = 453.592;

// Multiplier from "per 100 g" to the chosen weight unit.
const WEIGHT_FACTOR: Record<WeightUnit, number> = { "100g": 1, lb: GRAMS_PER_LB / 100, kg: 10 };
const WEIGHT_LABEL: Record<WeightUnit, string> = { "100g": "/100 g", lb: "/lb", kg: "/kg" };

export function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Converts a stored per-unit value (per 100 g / 100 mL / container) for display. */
export function displayValue(value: number, basis: UnitBasis | null, weight: WeightUnit): number {
  return basis === "100g" ? value * WEIGHT_FACTOR[weight] : value;
}

export function unitLabel(basis: UnitBasis | null, weight: WeightUnit): string {
  if (basis === "100g") return WEIGHT_LABEL[weight];
  if (basis === "100ml") return "/100 mL";
  if (basis === "container") return "per container";
  return "";
}

/** "$1.52 /100 g", "$6.88 /lb", "from $1.49 /100 g", "$1.00–2.22 /100 g", "$2.25 per container". */
export function perUnitText(price: Price, weight: WeightUnit): string | null {
  if (price.per_unit == null) return null;
  const basis = price.unit_basis;
  const unit = unitLabel(basis, weight);
  const value = money(displayValue(price.per_unit, basis, weight));
  if (price.per_unit_max != null) {
    return `${value}–${displayValue(price.per_unit_max, basis, weight).toFixed(2)} ${unit}`;
  }
  const isLowerBound = price.conditions?.toLowerCase().includes("pack up to") ?? false;
  return `${isLowerBound ? "from " : ""}${value} ${unit}`;
}

/** Container description: "473 mL", "8-pack", "6 × 473 mL". */
export function containerText(price: Price): string | null {
  const count = price.pack_count ?? 1;
  const size = price.container_size ? `${Number(price.container_size)} ${price.container_unit === "g" ? "g" : "mL"}` : null;
  if (count > 1) return size ? `${count} × ${size}` : `${count}-pack`;
  return size;
}

/** Shelf price as printed: "$6.88/lb", "$4.99 each". */
export function shelfPriceText(price: Price): string {
  const unit = price.price_unit;
  if (unit === "lb" || unit === "kg") return `${money(price.price)}/${unit}`;
  if (unit === "100g") return `${money(price.price)}/100 g`;
  return `${money(price.price)} each`;
}

/** Date-only strings ("2026-10-21") are calendar dates, so format them in UTC to avoid shifting a day. */
export function shortDate(value: string | null): string {
  if (!value) return "";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: dateOnly ? "UTC" : TIME_ZONE,
  }).format(new Date(dateOnly ? `${value}T00:00:00Z` : value));
}

/** "Oct 5–11" or "Sep 29 – Oct 5" for a week starting on the given Monday ("2026-09-29"). */
export function weekLabel(start: string): string {
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(first.getTime() + 6 * 86_400_000);
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: "UTC" }).format(d);
  return first.getUTCMonth() === last.getUTCMonth()
    ? `${fmt(first, { month: "short", day: "numeric" })}–${fmt(last, { day: "numeric" })}`
    : `${fmt(first, { month: "short", day: "numeric" })} – ${fmt(last, { month: "short", day: "numeric" })}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export function sourceLabel(source: Price["source"]): string {
  if (source === "flipp") return "Flyer";
  if (source === "website") return "Store website";
  return "Manual";
}
