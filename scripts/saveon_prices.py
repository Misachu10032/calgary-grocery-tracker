"""Save-On-Foods website collector: looks up tracked products that have
website_queries (e.g. energy drinks, protein) at the Calgary Heritage store and
saves their current shelf prices to the local database (data/prices.db).

Usage:
    python scripts/saveon_prices.py              # fetch and save
    python scripts/saveon_prices.py --dry-run    # fetch and print, write nothing

Uses Save-On's public search-preview endpoint (no browser needed). It returns
only a few products per search, so each product lists several search phrases.
Prices are regular shelf prices; members-only (More Rewards) deals are noted
in `conditions` but not applied.
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

from db import connect, finish_run, save_prices, start_run
from flipp_prices import SANE_RANGE, load_products, matches, parse_pack, parse_size

STORE_ID = "saveon-heritage"
PREVIEW_URL = "https://storefrontgateway.saveonfoods.com/api/stores/{rsid}/preview?q={query}"
PRODUCT_URL = "https://www.saveonfoods.com/sm/pickup/rsid/{rsid}/product/{slug}-id-{sku}"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
REQUEST_DELAY = 0.6  # seconds between requests

# unitOfSize.type → (multiplier to grams/millilitres, base unit)
SIZE_TYPES = {
    "gram": (1, "g"), "kilogram": (1000, "g"),
    "millilitre": (1, "ml"), "milliliter": (1, "ml"), "litre": (1000, "ml"), "liter": (1000, "ml"),
}


def fetch_preview(rsid, query):
    url = PREVIEW_URL.format(rsid=rsid, query=urllib.parse.quote(query))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp).get("products") or []


def money(text):
    m = re.search(r"\d+(?:\.\d+)?", (text or "").replace(",", ""))
    return float(m.group()) if m else None


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def size_of(item):
    """(amount, base_unit) for gram/millilitre sizes, or (count, 'each') for packs; None if unknown."""
    size = item.get("unitOfSize") or {}
    kind = (size.get("type") or "").lower()
    amount = size.get("size")
    if amount is None:
        return None
    if kind in SIZE_TYPES:
        factor, unit = SIZE_TYPES[kind]
        return float(amount) * factor, unit
    if kind == "each":
        return float(amount), "each"
    return None


def build_row(item, product, rsid):
    price = money(item.get("price"))
    if not price:
        return None
    basis = product["unit_basis"]
    size = size_of(item)
    # Save-On keeps the size out of the name, so apply the product's minimum here too
    # (e.g. skip 500 mL bottles when tracking 2 L bottles and multipacks).
    minimum = product.get("min_volume_ml")
    if minimum and size and size[1] == "ml" and size[0] < minimum:
        return None
    per_unit = None
    pack_count = container_size = container_unit = None

    if basis == "container":
        if size and size[1] == "each":
            pack_count = int(size[0])
            _, container_size, container_unit = parse_pack(item.get("name"))  # can size if printed
        elif size and size[1] == "ml":
            pack_count, container_size, container_unit = 1, size[0], "ml"
        else:
            pack_count = 1
        per_unit = price / pack_count
    elif size and size[1] == ("g" if basis == "100g" else "ml"):
        per_unit = price / size[0] * 100
    else:
        # Bags sold "each" often print the weight in the name ("Pears, 3lb Bag").
        printed = parse_size(item.get("name"))
        if printed and printed[2] == ("g" if basis == "100g" else "ml") and not printed[3]:
            per_unit = price / printed[1] * 100

    notes = []
    valid_to = None
    is_sale = False
    for promo in item.get("promotions") or []:
        if promo.get("loyaltyBased"):
            notes.append(f"More Rewards members: {promo.get('name')} until {promo.get('endDate')}")
        elif item.get("priceSource") == "promotion":
            is_sale = True
            valid_to = promo.get("endDate") or valid_to
            notes.append(promo.get("name") or "")

    low, high = SANE_RANGE.get(basis, (0, float("inf")))
    slim = {k: v for k, v in item.items() if k not in ("description", "categories", "defaultCategory")}
    return {
        "store_id": STORE_ID,
        "product_id": product["id"],
        "product_name": product["name_en"],
        "source": "website",
        "source_item_id": f"{item['sku']}:{product['slug']}",
        "item_name": item.get("name"),
        "price": price,
        "price_unit": "ea",
        "regular_price": money(item.get("wasPrice")),
        "is_sale": is_sale,
        "per_unit": round(per_unit, 3) if per_unit is not None else None,
        "per_unit_max": None,
        "unit_basis": basis,
        "conditions": "; ".join(n for n in notes if n) or None,
        "valid_from": None,
        "valid_to": valid_to,
        "url": PRODUCT_URL.format(rsid=rsid, slug=slugify(item.get("name")), sku=item["sku"]),
        "needs_review": per_unit is not None and not (low <= per_unit <= high),
        "raw": slim,
        "observed_on": date.today(),
        "pack_count": pack_count,
        "container_size": container_size,
        "container_unit": container_unit,
    }


def collect(products, rsid):
    rows, seen = [], set()
    for product in products:
        for query in product["website_queries"]:
            for item in fetch_preview(rsid, query):
                key = (item.get("sku"), product["id"])
                if not item.get("sku") or key in seen or not matches(item.get("name"), product):
                    continue
                seen.add(key)
                row = build_row(item, product, rsid)
                if row:
                    rows.append(row)
            time.sleep(REQUEST_DELAY)
    return rows


def describe(r):
    if r["unit_basis"] == "container":
        size = f"{r['container_size']:g} mL" if r["container_size"] else "size n/a"
        pack = f"{r['pack_count']}-pack" if (r["pack_count"] or 1) > 1 else "single"
        return f"${r['per_unit']:.2f} per container ({pack}, {size})"
    if r["per_unit"] is None:
        return "per-unit n/a"
    return f"${r['per_unit']:.2f}/{r['unit_basis'].replace('100', '100 ')}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print matches without writing to the database")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    conn = connect()
    try:
        rsid = conn.execute("select external_id from stores where id = ?", (STORE_ID,)).fetchone()[0]
        products = [p for p in load_products(conn) if p["website_queries"]]
        print(f"Save-On-Foods store {rsid}: {len(products)} product(s) with website queries…")

        run_id = None
        if not args.dry_run:
            run_id = start_run(conn, STORE_ID, "website")
            conn.commit()
        try:
            rows = collect(products, rsid)
            if not args.dry_run:
                save_prices(conn, rows)
                finish_run(conn, run_id, "ok", len(rows), f"{len(products)} product(s) searched")
                conn.commit()
        except Exception as exc:
            conn.rollback()
            if run_id is not None:
                finish_run(conn, run_id, "error", 0, str(exc)[:500])
                conn.commit()
            raise

        for r in sorted(rows, key=lambda r: (r["product_name"], r["per_unit"] or 1e9)):
            flag = "  [REVIEW]" if r["needs_review"] else ""
            print(f"  {r['product_name'][:26]:26} ${r['price']:>6.2f}  {describe(r):42} | {r['item_name'][:55]}{flag}")
        found = {r["product_name"] for r in rows}
        missing = [p["name_en"] for p in products if p["name_en"] not in found]
        if missing:
            print(f"\nNot found: {', '.join(missing)}")
        print(f"\n{'Would save' if args.dry_run else 'Saved'} {len(rows)} price row(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
