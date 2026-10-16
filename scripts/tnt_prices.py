"""T&T Supermarket website collector: searches T&T's online store (Calgary
Deerfoot, code DF) for every tracked product and saves current prices.

Usage:
    python scripts/tnt_prices.py              # fetch and save
    python scripts/tnt_prices.py --dry-run    # fetch and print, write nothing
    python scripts/tnt_prices.py --headed     # show the browser window

T&T's API rejects plain HTTP clients (Akamai), so this drives the installed
Google Chrome with Playwright and calls T&T's own GraphQL search from inside
the page, with the Calgary store headers the site itself sends.
"""
import argparse
import os
import sys
import time
from datetime import date
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

from flipp_prices import (LB_IN_G, SANE_RANGE, UPSERT_PRICE, finish_run, load_products, matches,
                          parse_pack, parse_size, start_run)

STORE_ID = "tnt-deerfoot"
HOME_URL = "https://www.tntsupermarket.com/eng/"
PRODUCT_URL = "https://www.tntsupermarket.com/eng/{path}"
STORE_HEADERS = {  # what the site sends after choosing Calgary (postcode T2P → Deerfoot store DF)
    "store": "default",
    "x-current-region": "AB",
    "x-prefered-store-code": "DF",
    "x-postcode": "T2P",
    "x-current-shipping-method": "delivery",
    "content-type": "application/json",
}
SEARCH_QUERY = """query S($q:String!){products(search:$q,pageSize:40,currentPage:1){total_count items{
  sku name url_key url_suffix stock_status was_price uom_type weight_uom
  price_range{minimum_price{final_price{value}}}}}}"""
UOM_PER_LB = 2  # uom_type 2: sold by weight, price is per lb; 1: sold each
REQUEST_DELAY = 0.6

SEARCH_JS = """async ({query, variables, headers}) => {
  const url = `/graphql?query=${encodeURIComponent(query)}&operationName=S&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const res = await fetch(url, {headers});
  const text = await res.text();
  try { return {status: res.status, data: JSON.parse(text)}; }
  catch { return {status: res.status, error: text.slice(0, 200)}; }
}"""


def search(page, term):
    result = page.evaluate(SEARCH_JS, {"query": SEARCH_QUERY, "variables": {"q": term}, "headers": STORE_HEADERS})
    if result.get("status") != 200 or "data" not in result:
        raise RuntimeError(f"T&T search {term!r}: HTTP {result.get('status')} {result.get('error', '')}")
    return ((result["data"].get("data") or {}).get("products") or {}).get("items") or []


def build_row(item, product):
    price = (((item.get("price_range") or {}).get("minimum_price") or {}).get("final_price") or {}).get("value")
    if not price:
        return None
    price = float(price)
    basis = product["unit_basis"]
    per_lb = item.get("uom_type") == UOM_PER_LB
    per_unit = None
    notes = []
    pack_count = container_size = container_unit = None

    if basis == "container":
        pack_count, container_size, container_unit = parse_pack(item.get("name"))
        per_unit = price / pack_count
    elif basis == "100g" and per_lb:
        per_unit = price / LB_IN_G * 100
    else:
        size = parse_size(item.get("name"))
        wanted = "g" if basis == "100g" else "ml"
        if size and size[2] == wanted and size[1] > 0 and not size[3]:
            per_unit = price / size[1] * 100
            if size[0] != size[1]:
                notes.append(f"size varies {size[0]:g}–{size[1]:g} {wanted}")

    was = float(item.get("was_price") or 0)
    regular = was if was > price else None
    low, high = SANE_RANGE.get(basis, (0, float("inf")))
    return {
        "store_id": STORE_ID,
        "product_id": product["id"],
        "product_name": product["name_en"],
        "source": "website",
        "source_item_id": f"{item['sku']}:{product['slug']}",
        "item_name": item.get("name"),
        "price": price,
        "price_unit": "lb" if per_lb else "ea",
        "regular_price": regular,
        "is_sale": regular is not None,
        "per_unit": round(per_unit, 3) if per_unit is not None else None,
        "per_unit_max": None,
        "unit_basis": basis,
        "conditions": "; ".join(["Online price"] + notes),
        "valid_from": None,
        "valid_to": None,
        "url": PRODUCT_URL.format(path=f"{item.get('url_key')}{item.get('url_suffix') or ''}"),
        "needs_review": per_unit is not None and not (low <= per_unit <= high),
        "raw": psycopg2.extras.Json(item),
        "observed_on": date.today(),
        "pack_count": pack_count,
        "container_size": container_size,
        "container_unit": container_unit,
    }


def collect(products, headed):
    rows, seen = [], set()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=not headed)
        try:
            page = browser.new_page(locale="en-CA")
            page.goto(HOME_URL, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(3000)  # let the site's bot check settle before calling the API
            for product in products:
                for term in product["website_queries"] or [product["name_en"]]:
                    for item in search(page, term):
                        key = (item.get("sku"), product["id"])
                        if not item.get("sku") or key in seen or item.get("stock_status") == "OUT_OF_STOCK":
                            continue
                        if not matches(item.get("name"), product):
                            continue
                        seen.add(key)
                        row = build_row(item, product)
                        if row:
                            rows.append(row)
                    time.sleep(REQUEST_DELAY)
        finally:
            browser.close()
    return rows


def describe(r):
    if r["per_unit"] is None:
        return "per-unit n/a"
    if r["unit_basis"] == "container":
        return f"${r['per_unit']:.2f} per container"
    return f"${r['per_unit']:.2f}/{r['unit_basis'].replace('100', '100 ')}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print matches without writing to the database")
    parser.add_argument("--headed", action="store_true", help="show the Chrome window")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")

    conn = psycopg2.connect(os.environ["SUPABASE_DB_URL"])
    try:
        with conn.cursor() as cur:
            products = load_products(cur)
        print(f"T&T Deerfoot: searching {len(products)} product(s)…")
        run_id = None
        if not args.dry_run:
            with conn.cursor() as cur:
                run_id = start_run(cur, STORE_ID, source="website")
            conn.commit()
        try:
            rows = collect(products, args.headed)
            if not args.dry_run:
                with conn.cursor() as cur:
                    psycopg2.extras.execute_batch(cur, UPSERT_PRICE, rows)
                    finish_run(cur, run_id, "ok", len(rows), f"{len(products)} product(s) searched")
                conn.commit()
        except Exception as exc:
            conn.rollback()
            if run_id is not None:
                with conn.cursor() as cur:
                    finish_run(cur, run_id, "blocked" if "HTTP 403" in str(exc) else "error", 0, str(exc)[:500])
                conn.commit()
            raise

        for r in sorted(rows, key=lambda r: (r["product_name"], r["per_unit"] or 1e9)):
            flag = "  [REVIEW]" if r["needs_review"] else ""
            print(f"  {r['product_name'][:26]:26} ${r['price']:>6.2f}/{r['price_unit']:2}  {describe(r):24} | {r['item_name'][:55]}{flag}")
        found = {r["product_name"] for r in rows if not r["needs_review"]}
        missing = [p["name_en"] for p in products if p["name_en"] not in found]
        print(f"\nFound {len(found)}/{len(products)}" + (f"; not found: {', '.join(missing)}" if missing else ""))
        print(f"{'Would save' if args.dry_run else 'Saved'} {len(rows)} price row(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
