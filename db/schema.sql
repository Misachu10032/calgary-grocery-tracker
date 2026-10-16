-- Calgary grocery price tracker: local SQLite schema (data/prices.db).
-- Created automatically by scripts/db.py when the database file doesn't exist.
-- Lists (search terms etc.) are JSON arrays stored as text; dates are ISO text
-- ("2026-10-16"); booleans are 0/1.

PRAGMA foreign_keys = ON;

-- One row per physical store or per flyer region prices are collected for.
CREATE TABLE IF NOT EXISTS stores (
  id           TEXT PRIMARY KEY,                -- 'tnt-deerfoot', 'saveon-heritage'
  chain        TEXT NOT NULL,                   -- 'T&T', 'Save-On-Foods'
  name         TEXT NOT NULL,                   -- 'Deerfoot', 'Calgary (flyer)'
  city         TEXT NOT NULL DEFAULT 'Calgary',
  province     TEXT NOT NULL DEFAULT 'AB',
  address      TEXT,
  postal_code  TEXT,
  external_id  TEXT,                            -- store code on the chain's site: 'DF', '6634'
  website      TEXT
);

-- Website sections; a product can be in several.
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,             -- 'meat', 'vegetables', 'gym'
  name_en     TEXT NOT NULL,
  name_zh     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

-- The items you track. Matching rule (scripts/flipp_prices.py): an item matches when
-- ANY search term appears as a whole word and NO exclude term starts a word.
CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,        -- 'chicken-breast-boneless-skinless'
  name_en          TEXT NOT NULL,
  name_zh          TEXT,
  unit_basis       TEXT NOT NULL DEFAULT '100g'
                   CHECK (unit_basis IN ('100g', '100ml', 'each', 'container')),
  search_terms     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  exclude_terms    TEXT NOT NULL DEFAULT '[]',  -- JSON array
  website_queries  TEXT NOT NULL DEFAULT '[]',  -- JSON array: phrases searched on store sites
  image_url        TEXT,                        -- optional photo; else web/public/products/<slug>.*
  active           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_categories (
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);

-- One row per item per store per day; never overwritten, so history builds up.
CREATE TABLE IF NOT EXISTS prices (
  id              INTEGER PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id),
  product_id      INTEGER REFERENCES products(id),
  source          TEXT NOT NULL CHECK (source IN ('website', 'flipp', 'manual')),
  source_item_id  TEXT NOT NULL,               -- '<flipp id>:<slug>', '<sku>:<slug>'
  item_name       TEXT NOT NULL,
  price           REAL NOT NULL CHECK (price >= 0),
  price_unit      TEXT,                        -- 'ea', 'lb', 'kg', '100g'
  regular_price   REAL,                        -- "was" price when on sale
  is_sale         INTEGER NOT NULL DEFAULT 0,
  per_unit        REAL,                        -- per 100 g / 100 mL, or per container
  per_unit_max    REAL,                        -- upper bound when the pack size is a range
  unit_basis      TEXT CHECK (unit_basis IN ('100g', '100ml', 'each', 'container')),
  conditions      TEXT,                        -- 'LIMIT 4', 'PC Optimum Member-Only Price'
  valid_from      TEXT,
  valid_to        TEXT,
  url             TEXT,
  needs_review    INTEGER NOT NULL DEFAULT 0,  -- failed a sanity check; hidden from the site
  raw             TEXT,                        -- original payload (JSON), for debugging parsers
  pack_count      INTEGER,                     -- containers in the pack
  container_size  REAL,                        -- size of one container, e.g. 473
  container_unit  TEXT CHECK (container_unit IN ('ml', 'g')),
  observed_on     TEXT NOT NULL DEFAULT (date('now', 'localtime')),
  checked_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, source, source_item_id, observed_on)
);

CREATE INDEX IF NOT EXISTS prices_product_latest_idx ON prices (product_id, store_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS prices_observed_idx ON prices (observed_on);

-- One row per collector run per store: "last checked" and block detection.
CREATE TABLE IF NOT EXISTS scrape_runs (
  id           INTEGER PRIMARY KEY,
  store_id     TEXT REFERENCES stores(id),
  source       TEXT NOT NULL CHECK (source IN ('website', 'flipp', 'manual')),
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'ok', 'partial', 'blocked', 'error')),
  items_found  INTEGER NOT NULL DEFAULT 0,
  message      TEXT
);

-- Latest price of each tracked product at each store; when a store has several
-- matches on the same day, the cheapest per unit wins. Expired sale prices drop out.
DROP VIEW IF EXISTS latest_prices;
CREATE VIEW latest_prices AS
WITH ranked AS (
  SELECT p.*,
         ROW_NUMBER() OVER (
           PARTITION BY p.product_id, p.store_id
           ORDER BY p.observed_on DESC, p.per_unit IS NULL, p.per_unit, p.price
         ) AS rn
  FROM prices p
  WHERE p.product_id IS NOT NULL
    AND p.needs_review = 0
    AND (p.valid_to IS NULL OR p.valid_to >= date('now', 'localtime'))
)
SELECT r.product_id, pr.slug, pr.name_en, r.store_id, s.chain, s.name AS store_name,
       r.item_name, r.price, r.price_unit, r.regular_price, r.is_sale,
       r.per_unit, r.per_unit_max, r.unit_basis, r.conditions,
       r.valid_from, r.valid_to, r.url, r.source, r.observed_on, r.checked_at,
       r.pack_count, r.container_size, r.container_unit
FROM ranked r
JOIN products pr ON pr.id = r.product_id
JOIN stores s ON s.id = r.store_id
WHERE r.rn = 1;

-- Best price of each tracked product at each store per week (weeks start Monday).
DROP VIEW IF EXISTS weekly_prices;
CREATE VIEW weekly_prices AS
WITH weekly AS (
  SELECT p.*,
         date(p.observed_on, '-' || ((CAST(strftime('%w', p.observed_on) AS INTEGER) + 6) % 7) || ' days') AS week_start
  FROM prices p
  WHERE p.product_id IS NOT NULL AND p.needs_review = 0
), ranked AS (
  SELECT w.*,
         ROW_NUMBER() OVER (
           PARTITION BY w.product_id, w.store_id, w.week_start
           ORDER BY w.observed_on DESC, w.per_unit IS NULL, w.per_unit, w.price
         ) AS rn
  FROM weekly w
)
SELECT r.week_start, r.product_id, r.store_id, s.chain, s.name AS store_name,
       r.item_name, r.price, r.price_unit, r.regular_price, r.is_sale,
       r.per_unit, r.per_unit_max, r.unit_basis, r.conditions,
       r.valid_from, r.valid_to, r.url, r.source, r.observed_on, r.checked_at,
       r.pack_count, r.container_size, r.container_unit
FROM ranked r
JOIN stores s ON s.id = r.store_id
WHERE r.rn = 1;
