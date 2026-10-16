"""Export what the website needs from data/prices.db to web/data/site-data.json.

The website build (web/lib/data.ts) reads only this file, so the database itself
never leaves this computer. Commit and push the JSON to publish new prices.

Usage:
    python scripts/export_site_data.py
"""
import json
import sys
from datetime import date, datetime, timedelta, timezone

from db import ROOT, connect

OUT_PATH = ROOT / "web" / "data" / "site-data.json"
HISTORY_WEEKS = 6  # past weeks included for each item's price history

PRICE_COLUMNS = """product_id, store_id, chain, store_name, item_name, price, price_unit, regular_price,
    is_sale, per_unit, per_unit_max, unit_basis, conditions, valid_from, valid_to, url, source,
    observed_on, checked_at, pack_count, container_size, container_unit"""


def iso_utc(value):
    """SQLite datetime('now') text ("2026-10-16 05:27:00", UTC) -> ISO 8601 with Z."""
    return f"{value.replace(' ', 'T')}Z" if value else None


def fetch(conn, sql, params=()):
    return [dict(row) for row in conn.execute(sql, params)]


def clean_prices(rows):
    for row in rows:
        row["is_sale"] = bool(row["is_sale"])
        row["checked_at"] = iso_utc(row["checked_at"])
    return rows


def export(conn):
    today = date.today()
    current_week = today - timedelta(days=today.weekday())
    history_from = current_week - timedelta(weeks=HISTORY_WEEKS)
    weekly = clean_prices(fetch(conn, f"""
        select week_start, {PRICE_COLUMNS} from weekly_prices
        where week_start >= ? and week_start < ? order by week_start desc""",
        (history_from.isoformat(), current_week.isoformat())))
    runs = fetch(conn, """select store_id, max(finished_at) as finished_at from scrape_runs
                          where status = 'ok' and store_id is not null group by store_id""")
    for run in runs:
        run["finished_at"] = iso_utc(run["finished_at"])
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "products": fetch(conn, """select id, slug, name_en, name_zh, unit_basis, image_url
                                   from products where active = 1 order by id"""),
        "categories": fetch(conn, """select slug, name_en, name_zh, sort_order
                                     from categories where active = 1 order by sort_order"""),
        "product_categories": fetch(conn, """select pc.product_id, c.slug as category
                                             from product_categories pc join categories c on c.id = pc.category_id
                                             order by pc.product_id, c.sort_order"""),
        "stores": fetch(conn, "select id, chain, name, website from stores order by chain"),
        "latest_prices": clean_prices(fetch(conn, f"select {PRICE_COLUMNS} from latest_prices order by product_id, store_id")),
        "weekly_prices": weekly,
        "runs": runs,
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    conn = connect()
    try:
        data = export(conn)
    finally:
        conn.close()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}: {len(data['latest_prices'])} current prices, "
          f"{len(data['weekly_prices'])} history rows, {OUT_PATH.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
