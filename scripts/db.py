"""Local SQLite database shared by the collectors and the site export.

The database lives in data/prices.db and is created from db/schema.sql on first use.
"""
import json
import sqlite3
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "prices.db"
SCHEMA_PATH = ROOT / "db" / "schema.sql"


def connect(path=DB_PATH):
    """Open the database, creating tables and (re)creating views if needed."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))  # idempotent
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


UPSERT_PRICE = """
INSERT INTO prices (store_id, product_id, source, source_item_id, item_name, price, price_unit,
                    regular_price, is_sale, per_unit, per_unit_max, unit_basis, conditions,
                    valid_from, valid_to, url, needs_review, raw, observed_on, checked_at,
                    pack_count, container_size, container_unit)
VALUES (:store_id, :product_id, :source, :source_item_id, :item_name, :price, :price_unit,
        :regular_price, :is_sale, :per_unit, :per_unit_max, :unit_basis, :conditions,
        :valid_from, :valid_to, :url, :needs_review, :raw, :observed_on, datetime('now'),
        :pack_count, :container_size, :container_unit)
ON CONFLICT (store_id, source, source_item_id, observed_on) DO UPDATE SET
  product_id = excluded.product_id, item_name = excluded.item_name, price = excluded.price,
  price_unit = excluded.price_unit, regular_price = excluded.regular_price, is_sale = excluded.is_sale,
  per_unit = excluded.per_unit, per_unit_max = excluded.per_unit_max, unit_basis = excluded.unit_basis,
  conditions = excluded.conditions, valid_from = excluded.valid_from, valid_to = excluded.valid_to,
  url = excluded.url, needs_review = excluded.needs_review, raw = excluded.raw, checked_at = datetime('now'),
  pack_count = excluded.pack_count, container_size = excluded.container_size,
  container_unit = excluded.container_unit
"""


def _sql_value(value):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def save_prices(conn, rows):
    """Insert or update price rows (dicts built by the collectors)."""
    conn.executemany(UPSERT_PRICE, [{k: _sql_value(v) for k, v in row.items()} for row in rows])


def start_run(conn, store_id, source):
    cur = conn.execute("INSERT INTO scrape_runs (store_id, source) VALUES (?, ?)", (store_id, source))
    return cur.lastrowid


def finish_run(conn, run_id, status, items_found, message):
    conn.execute(
        "UPDATE scrape_runs SET finished_at = datetime('now'), status = ?, items_found = ?, message = ? WHERE id = ?",
        (status, items_found, message, run_id),
    )
