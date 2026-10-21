"""Weekly flyer collector: finds tracked products in Calgary flyers on Flipp and
saves their prices (with price per 100 g / 100 mL) to the local database (data/prices.db).

Usage:
    python scripts/flipp_prices.py              # fetch and save
    python scripts/flipp_prices.py --dry-run    # fetch and print, write nothing

Writes to the local SQLite database (data/prices.db). Flipp's endpoints are unofficial and may change.
"""
import argparse
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

from db import connect, finish_run, save_prices, start_run

POSTAL_CODE = "T2P1J9"  # downtown Calgary
FLYERS_URL = "https://flyers-ng.flippback.com/api/flipp/data?locale=en&postal_code={postal}&sid={sid}"
ITEMS_URL = "https://flyers-ng.flippback.com/api/flipp/flyers/{flyer_id}/flyer_items?locale=en&sid={sid}"
DETAIL_URL = "https://backflipp.wishabi.com/flipp/items/{item_id}"
REQUEST_DELAY = 0.5  # seconds between Flipp requests

# Flipp merchant name → stores.id. Matching is exact on the merchant name, so
# look-alike banners (e.g. "Chalo FreshCo", "Real Canadian Liquor Store") are skipped.
MERCHANT_STORES = {
    "No Frills": "nofrills-calgary",
    "Real Canadian Superstore": "superstore-calgary",
    "FreshCo": "freshco-calgary",
    "Save-On-Foods": "saveon-heritage",
    "Walmart": "walmart-tsuutina",
    "T&T Supermarket": "tnt-deerfoot",
    "Costco": "costco-calgary",
}
WHOLESALE_CLUB_PREFIX = "Wholesale Club"  # Flipp name has a French suffix ("… and Club Entrepôt")

# Prices per 100 units (or per container) outside these bounds are saved but hidden (needs_review).
SANE_RANGE = {"100g": (0.05, 15.0), "100ml": (0.03, 5.0), "container": (0.5, 15.0)}
LB_IN_G = 453.592


# ─── Flipp ──────────────────────────────────────────────────────────────────

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def store_for_merchant(merchant):
    merchant = (merchant or "").strip()
    if merchant.startswith(WHOLESALE_CLUB_PREFIX):
        return "wholesaleclub-calgary"
    return MERCHANT_STORES.get(merchant)


def current_flyers(sid):
    """Flyers valid right now for tracked merchants, as (store_id, flyer) pairs."""
    data = fetch_json(FLYERS_URL.format(postal=POSTAL_CODE, sid=sid))
    now = datetime.now(timezone.utc)
    result = []
    for flyer in data.get("flyers", []):
        store_id = store_for_merchant(flyer.get("merchant"))
        if not store_id:
            continue
        valid_from = datetime.fromisoformat(flyer["valid_from"])
        valid_to = datetime.fromisoformat(flyer["valid_to"])
        if valid_from <= now <= valid_to:
            result.append((store_id, flyer))
    return result


# ─── Matching ───────────────────────────────────────────────────────────────

CJK = re.compile(r"[一-鿿]")


def normalise(text):
    text = (text or "").lower()
    text = re.sub(r"[-_®™'’]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def contains(text, term, whole_word):
    """Term appears in text starting at a word boundary. With whole_word it must
    also end there (an 's'/'es' plural is allowed), so 'bosc' doesn't match
    'bosch'. CJK terms match anywhere."""
    term = normalise(term)
    if not term:
        return False
    if CJK.search(term):
        return term in text
    pattern = r"(?<![a-z0-9])" + re.escape(term) + (r"(?:e?s)?(?![a-z0-9])" if whole_word else "")
    return re.search(pattern, text) is not None


# Fresh products (meat, vegetables, fruit) also reject anything processed or non-food.
# Online catalogues (Walmart) list baby food, snacks, pet food, yarn colours and
# furniture whose names contain "banana", "tomato", "pear"…
FRESH_CATEGORIES = {"meat", "vegetables", "fruit"}
FRESH_EXCLUDE = [
    "baby", "gerber", "parent s choice", "little bellies", "love child", "teething", "puree", "purée",
    "pouch", "snack", "chip", "cracker", "cereal", "rusk", "puff", "wafer", "bites", "nibble", "stick",
    "dog", "cat", "pet", "purina", "nutro", "beneful", "fancy feast", "blue buffalo",
    "sauce", "marinade", "marinara", "juice", "nectar", "soda", "tea", "dessert", "cake", "cookie",
    "bread", "muffin", "pie", "mallow", "lolly", "candy", "smoothie", "yogurt", "cheese", "cheesy", "creamed",
    "dinner", "entree", "entrée", "bowl", "mac", "gnocchi", "pasta", "cannelloni", "frittata", "gratin",
    "momos", "dumpling", "kibbeh", "lo mein", "dip", "w/", "medley", "superblend", "variety",
    "oil", "extract", "jar", "canned", "pickled", "stuffed", "leaves",
    "yarn", "acrylic", "worsted", "vinyl", "cricut", "chair", "bean bag", "beanbag", "cushion", "tape",
    "game", "toy", "costume", "caplet", "supplement", "jamieson", "christmas", "holiday",
    "glazed", "restaurant", "sides", "roasted", "crisp", "baguette", "lay", "chubby", "tandoori", "kebab",
    "cactus", "onion", "kitchen", "soup", "miso",
]
LIQUID_SIZE = re.compile(r"\d\s*(?:ml|l)\b")  # "600ml", "1 L": fresh items are never sold by volume


def matches(text, product):
    """Search terms must match whole words; exclude terms match word prefixes
    ('flavour' also rejects 'flavoured'), so exclusion errs on the safe side."""
    if not big_enough(text, product):
        return False
    text = normalise(text)
    fresh = product.get("is_fresh")
    if fresh and LIQUID_SIZE.search(text):
        return False
    excludes = product["exclude_terms"] + (FRESH_EXCLUDE if fresh else [])
    return (any(contains(text, t, whole_word=True) for t in product["search_terms"])
            and not any(contains(text, t, whole_word=False) for t in excludes))


# ─── Price per 100 g / 100 mL ───────────────────────────────────────────────

NUM = r"(\d+(?:\.\d+)?)"
UNIT_NAMES = r"(MILLILITRES?|MILLILITERS?|LITRES?|LITERS?|KG|G|ML|L|LBS|LB)"  # Save-On spells out "2 Litre"
UNIT = UNIT_NAMES + r"\b"


def big_enough(text, product):
    """False when the listing's printed total volume is below the product's minimum
    (e.g. single cans when tracking 2 L bottles and multipacks). Unknown sizes pass."""
    minimum = product.get("min_volume_ml")
    if not minimum:
        return True
    size = parse_size(text)
    return not (size and size[2] == "ml" and size[1] < minimum)


def to_base(value, unit):
    """Convert a pack size to grams or millilitres: returns (amount, 'g'|'ml')."""
    value = float(value)
    unit = unit.upper()
    if unit == "KG":
        return value * 1000, "g"
    if unit == "G":
        return value, "g"
    if unit in ("LB", "LBS"):
        return value * LB_IN_G, "g"
    if unit == "L" or unit.startswith(("LITRE", "LITER")):
        return value * 1000, "ml"
    return value, "ml"  # ML, MILLILITRE(S), MILLILITER(S)


def parse_size(text):
    """Pack size from a flyer name/description.

    Returns (min_amount, max_amount, base_unit, up_to) or None. Handles
    '454 G', '6 x 473 mL', '300-437 g', '170/175 g', 'UP TO 630 G', '1.5LB'.
    """
    t = (text or "").upper()
    up_to = "UP TO" in t
    m = re.search(rf"(\d+)\s*[X×]\s*{NUM}\s*{UNIT}", t)
    if m:
        amount, base = to_base(float(m.group(1)) * float(m.group(2)), m.group(3))
        return amount, amount, base, up_to
    m = re.search(rf"{NUM}\s*{UNIT_NAMES}\s*[X×]\s*(\d+)\b", t)  # size first: '355mlx12' (T&T)
    if m:
        amount, base = to_base(float(m.group(1)) * float(m.group(3)), m.group(2))
        return amount, amount, base, up_to
    m = re.search(rf"{NUM}\s*(?:-|–|/|TO)\s*{NUM}\s*{UNIT}", t)
    if m:
        lo, base = to_base(m.group(1), m.group(3))
        hi, _ = to_base(m.group(2), m.group(3))
        return min(lo, hi), max(lo, hi), base, up_to
    m = re.search(rf"{NUM}\s*{UNIT}", t)
    if m:
        amount, base = to_base(m.group(1), m.group(2))
        return amount, amount, base, up_to
    return None


def multi_buy_count(pre, post):
    """'2/' or '3 FOR' style offers: number of units the price covers."""
    m = re.match(r"\s*(\d+)\s*/", pre or "") or re.search(r"(\d+)\s*FOR\b", f"{pre or ''} {post or ''}".upper())
    return int(m.group(1)) if m and int(m.group(1)) > 1 else 1


def parse_pack(text):
    """Containers in a listing: (count, size, unit) for '6 x 473 mL', '473 mL',
    '12 PACK' / '12-pack' / '12 x cans'. Size/unit are None when not printed."""
    t = (text or "").upper()
    # '12 X 473 ML', and ranges like '12 X 444-473 ML' (mixed brands); keep the larger size.
    m = re.search(rf"(\d+)\s*[X×]\s*{NUM}(?:\s*[-–/]\s*{NUM})?\s*(ML|L|G|KG)\b", t)
    if m:
        size, unit = to_base(m.group(3) or m.group(2), m.group(4))
        return int(m.group(1)), size, unit
    m = re.search(rf"{NUM}\s*(ML|L|G|KG)\s*[X×]\s*(\d+)\b", t)  # size first: '355mlx12' (T&T)
    if m:
        size, unit = to_base(m.group(1), m.group(2))
        return int(m.group(3)), size, unit
    count_match = re.search(r"(\d+)\s*(?:-\s*)?(?:PACK|PK|CANS|BOTTLES|CT)\b", t)
    count = int(count_match.group(1)) if count_match else 1
    m = re.search(rf"{NUM}\s*(ML|L)\b", t)
    if m:
        size, unit = to_base(m.group(1), m.group(2))
        return count, size, unit
    return count, None, None


def price_per_unit(item, basis):
    """Returns (per_unit, per_unit_max, price_unit, notes, pack) for a Flipp item detail.

    per_unit is per 100 g / 100 mL, or per container for basis 'container'.
    pack is (count, container_size, container_unit) for containers, else None.
    """
    price = float(item.get("current_price") or 0)
    if price <= 0:
        return None, None, None, [], None
    pre = item.get("pre_price_text") or ""
    post = (item.get("price_text") or "").strip()
    desc = item.get("description") or ""
    name = item.get("name") or ""
    notes = []

    count = multi_buy_count(pre, post)
    if count > 1:
        price /= count
        notes.append(f"{count} for ${float(item['current_price']):.2f}")

    if basis == "container":
        pack = parse_pack(f"{name} {desc}")
        return price / pack[0], None, "ea", notes, pack

    post_unit = re.sub(r"[^A-Z0-9]", "", post.upper())
    if basis == "100g":
        m = re.search(rf"{NUM}\s*/\s*KG", desc.upper())
        if m:
            return float(m.group(1)) / 10, None, "lb" if post_unit == "LB" else "kg", notes, None
        if post_unit in ("LB", "PERLB"):
            return price / LB_IN_G * 100, None, "lb", notes, None
        if post_unit in ("KG", "PERKG"):
            return price / 10, None, "kg", notes, None
        m = re.search(rf"{NUM}\s*/\s*100\s*G", desc.upper())
        if m:
            return float(m.group(1)), None, "100g", notes, None

    size = parse_size(f"{name} {desc}")
    wanted = "g" if basis == "100g" else "ml"
    if not size or size[2] != wanted or size[0] <= 0 or size[1] <= 0:
        return None, None, "ea", notes, None
    lo_amount, hi_amount, _, up_to = size
    if up_to:
        notes.append(f"pack up to {hi_amount:g} {wanted}; actual price per 100 {wanted} may be higher")
        return price / hi_amount * 100, None, "ea", notes, None
    per_unit = price / hi_amount * 100
    per_unit_max = price / lo_amount * 100 if lo_amount != hi_amount else None
    if per_unit_max:
        notes.append(f"size varies {lo_amount:g}–{hi_amount:g} {wanted}")
    return per_unit, per_unit_max, "ea", notes, None


# ─── Database ───────────────────────────────────────────────────────────────

def load_products(conn):
    """Active tracked products with their match terms (JSON lists) and categories.
    Shared with the other collectors."""
    rows = conn.execute("""
        select p.id, p.slug, p.name_en, p.unit_basis, p.search_terms, p.exclude_terms, p.website_queries,
               p.min_volume_ml,
               coalesce(json_group_array(c.slug) filter (where c.slug is not null), '[]') as categories
        from products p
        left join product_categories pc on pc.product_id = p.id
        left join categories c on c.id = pc.category_id
        where p.active = 1
        group by p.id order by p.id""").fetchall()
    products = []
    for row in rows:
        product = dict(row)
        for key in ("search_terms", "exclude_terms", "website_queries", "categories"):
            product[key] = json.loads(product[key] or "[]")
        if not product["search_terms"]:
            continue
        product["is_fresh"] = bool(FRESH_CATEGORIES & set(product["categories"]))
        products.append(product)
    return products


# ─── Collection ─────────────────────────────────────────────────────────────

SEARCH_URL = "https://backflipp.wishabi.com/flipp/items/search?locale=en-ca&postal_code={postal}&q={query}"
# Online catalogues Flipp search exposes as `ecom_items` (regular shelf prices).
ECOM_STORES = {"Walmart": "walmart-tsuutina"}
WALMART_PRODUCT_URL = "https://www.walmart.ca/en/ip/{slug}/{sku}"


def to_date(value):
    return datetime.fromisoformat(value).date() if value else None


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def flyer_rows(detail, candidates, store_id, item_id):
    """Price rows for one Flipp flyer item detail, one per matching product."""
    rows = []
    full_text = f"{detail.get('name')} {detail.get('description') or ''}"
    for product in candidates:
        if not matches(full_text, product):  # description may reveal an exclude term (e.g. FROZEN)
            continue
        per_unit, per_unit_max, price_unit, notes, pack = price_per_unit(detail, product["unit_basis"])
        pack_count, container_size, container_unit = pack or (None, None, None)
        low, high = SANE_RANGE.get(product["unit_basis"], (0, float("inf")))
        conditions = [c for c in (detail.get("pre_price_text"), detail.get("price_text"),
                                  detail.get("disclaimer_text")) if c and c.strip().upper() not in ("LB", "KG", "SALE")]
        rows.append({
            "store_id": store_id,
            "product_id": product["id"],
            "product_name": product["name_en"],
            "source": "flipp",
            "is_sale": True,
            "pack_count": pack_count,
            "container_size": container_size,
            "container_unit": container_unit,
            "source_item_id": f"{item_id}:{product['slug']}",
            "item_name": detail.get("name"),
            "price": float(detail.get("current_price") or 0),
            "price_unit": price_unit,
            "regular_price": float(detail["original_price"]) if detail.get("original_price") else None,
            "per_unit": round(per_unit, 3) if per_unit is not None else None,
            "per_unit_max": round(per_unit_max, 3) if per_unit_max is not None else None,
            "unit_basis": product["unit_basis"],
            "conditions": "; ".join(conditions + notes) or None,
            "valid_from": to_date(detail.get("valid_from")),
            "valid_to": to_date(detail.get("valid_to")),
            "url": detail.get("ttm_url") or None,
            "needs_review": per_unit is not None and not (low <= per_unit <= high),
            "raw": detail,
            "observed_on": date.today(),
        })
    return rows


def ecom_row(item, product, store_id):
    """Price row for an online-catalogue item from Flipp search (e.g. Walmart.ca)."""
    price = float(item.get("current_price") or 0)
    if price <= 0:
        return None
    # Online names carry the size ("473ml", "1.2 kg"); reuse the flyer parser on the name only.
    per_unit, per_unit_max, _, notes, pack = price_per_unit({"current_price": price, "name": item.get("name")},
                                                             product["unit_basis"])
    pack_count, container_size, container_unit = pack or (None, None, None)
    original = item.get("original_price")
    regular = float(original) if original and float(original) > price else None
    low, high = SANE_RANGE.get(product["unit_basis"], (0, float("inf")))
    slim = {k: v for k, v in item.items() if k not in ("description", "image_url", "merchant_logo")}
    return {
        "store_id": store_id,
        "product_id": product["id"],
        "product_name": product["name_en"],
        "source": "website",
        "is_sale": regular is not None,
        "pack_count": pack_count,
        "container_size": container_size,
        "container_unit": container_unit,
        "source_item_id": f"ecom:{item.get('sku')}:{product['slug']}",
        "item_name": item.get("name"),
        "price": price,
        "price_unit": "ea",
        "regular_price": regular,
        "per_unit": round(per_unit, 3) if per_unit is not None else None,
        "per_unit_max": round(per_unit_max, 3) if per_unit_max is not None else None,
        "unit_basis": product["unit_basis"],
        "conditions": "; ".join(["Online price"] + notes),
        "valid_from": None,
        "valid_to": None,
        "url": WALMART_PRODUCT_URL.format(slug=slugify(item.get("name")), sku=item.get("sku")),
        "needs_review": per_unit is not None and not (low <= per_unit <= high),
        "raw": slim,
        "observed_on": date.today(),
    }


def collect_store(store_id, flyers, products, sid):
    """Phase 1: scan every currently valid flyer of one store."""
    rows, seen = [], set()
    for flyer in flyers:
        items = fetch_json(ITEMS_URL.format(flyer_id=flyer["id"], sid=sid))
        time.sleep(REQUEST_DELAY)
        for listed in items:
            if not listed.get("price"):
                continue
            candidates = [p for p in products if matches(listed.get("name"), p)]
            if not candidates or listed["id"] in seen:
                continue
            seen.add(listed["id"])
            detail = fetch_json(DETAIL_URL.format(item_id=listed["id"]))["item"]
            time.sleep(REQUEST_DELAY)
            rows.extend(flyer_rows(detail, candidates, store_id, listed["id"]))
    return rows


def collect_search(products, known_ids):
    """Phase 2: Flipp search per product phrase. Finds flyer items the scan missed
    and online-catalogue items (Walmart). known_ids holds (store_id, source_item_id)
    already collected and is updated in place."""
    rows = []
    now = datetime.now(timezone.utc)
    for product in products:
        for query in product["website_queries"] or [product["name_en"]]:
            try:
                data = fetch_json(SEARCH_URL.format(postal=POSTAL_CODE, query=urllib.parse.quote(query)))
            except Exception as exc:
                print(f"  search {query!r} failed: {exc}")
                continue
            time.sleep(REQUEST_DELAY)
            for item in data.get("items") or []:
                store_id = store_for_merchant(item.get("merchant_name"))
                item_id = item.get("flyer_item_id") or item.get("id")
                if not store_id or not item.get("current_price") or not item_id:
                    continue
                if item.get("valid_to") and datetime.fromisoformat(item["valid_to"]) < now:
                    continue
                key = (store_id, f"{item_id}:{product['slug']}")
                if key in known_ids or not matches(item.get("name"), product):
                    continue
                known_ids.add(key)
                try:
                    detail = fetch_json(DETAIL_URL.format(item_id=item_id))["item"]
                except Exception as exc:
                    print(f"  item {item_id} failed: {exc}")
                    continue
                time.sleep(REQUEST_DELAY)
                rows.extend(flyer_rows(detail, [product], store_id, item_id))
            for item in data.get("ecom_items") or []:
                store_id = ECOM_STORES.get(item.get("merchant"))
                if not store_id or not item.get("sku") or not matches(item.get("name"), product):
                    continue
                key = (store_id, f"ecom:{item['sku']}:{product['slug']}")
                if key in known_ids:
                    continue
                known_ids.add(key)
                row = ecom_row(item, product, store_id)
                if row:
                    rows.append(row)
    return rows


# ─── Main ───────────────────────────────────────────────────────────────────

def describe(r):
    unit = " per container" if r["unit_basis"] == "container" else r["unit_basis"].replace("100", "/100 ")
    if r["per_unit"] is None:
        return "per-unit n/a"
    if r["per_unit_max"]:
        return f"${r['per_unit']:.2f}–{r['per_unit_max']:.2f}{unit}"
    return f"${r['per_unit']:.2f}{unit}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print matches without writing to the database")
    parser.add_argument("--quiet", action="store_true", help="only print the coverage summary")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    sid = "".join(random.choice("0123456789") for _ in range(16))
    conn = connect()
    try:
        products = load_products(conn)
        print(f"{len(products)} tracked products; Calgary ({POSTAL_CODE})")

        flyers_by_store = {}
        for store_id, flyer in current_flyers(sid):
            flyers_by_store.setdefault(store_id, []).append(flyer)

        rows_by_store, errors, known = {}, {}, set()
        print("Phase 1: scanning flyers…")
        for store_id, flyers in sorted(flyers_by_store.items()):
            try:
                for r in collect_store(store_id, flyers, products, sid):
                    rows_by_store.setdefault(store_id, []).append(r)
                    known.add((store_id, r["source_item_id"]))
            except Exception as exc:  # one store failing must not stop the others
                errors[store_id] = str(exc)[:500]
                print(f"  {store_id}: ERROR {exc}")
        print("Phase 2: searching Flipp (all flyers + online catalogues)…")
        for r in collect_search(products, known):
            rows_by_store.setdefault(r["store_id"], []).append(r)

        total = 0
        for store_id in sorted(set(rows_by_store) | set(flyers_by_store) | set(errors)):
            rows = rows_by_store.get(store_id, [])
            if not args.dry_run:
                run_id = start_run(conn, store_id, "flipp")
                save_prices(conn, rows)
                status = "error" if store_id in errors and not rows else ("partial" if store_id in errors else "ok")
                finish_run(conn, run_id, status, len(rows), errors.get(store_id) or
                           f"{len(flyers_by_store.get(store_id, []))} flyer(s) + search")
                conn.commit()
            total += len(rows)
            if not args.quiet:
                print(f"\n{store_id}: {len(rows)} row(s)")
                for r in sorted(rows, key=lambda r: (r["product_name"], r["per_unit"] or 1e9)):
                    flag = "  [REVIEW]" if r["needs_review"] else ""
                    src = "web" if r["source"] == "website" else "fly"
                    print(f"  {src} {r['product_name'][:24]:24} ${r['price']:>7.2f} {describe(r):24} | {r['item_name'][:58]}{flag}")

        print("\nCoverage (tracked items found per store):")
        for store_id in sorted(rows_by_store):
            found = {r["product_name"] for r in rows_by_store[store_id] if not r["needs_review"]}
            print(f"  {store_id:24} {len(found):2}/{len(products)}")
        print(f"\n{'Would save' if args.dry_run else 'Saved'} {total} price row(s).")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
