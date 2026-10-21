-- Calgary grocery price tracker: initial schema.
-- Run once in Supabase → SQL Editor, or apply with psql / `supabase db push`.
-- The local script writes with the secret (service_role) key, which bypasses RLS;
-- the website reads with the publishable (anon) key: read-only via grants + policies below.

-- ─── Stores ────────────────────────────────────────────────────────────────
-- One row per physical store or per flyer region we collect prices for.
create table stores (
  id            text primary key,                 -- 'tnt-deerfoot', 'saveon-heritage'
  chain         text not null,                    -- 'T&T', 'Save-On-Foods'
  name          text not null,                    -- 'Deerfoot', 'Heritage', 'Calgary (flyer)'
  city          text not null default 'Calgary',
  province      text not null default 'AB',
  address       text,
  postal_code   text,
  external_id   text,                             -- store code on the chain's site: 'DF', '6634', '3010'
  website       text,
  created_at    timestamptz not null default now()
);

-- ─── Products ──────────────────────────────────────────────────────────────
-- The items you track and compare across stores (your list, not every flyer item).
create table products (
  id            bigint generated always as identity primary key,
  slug          text not null unique,             -- 'chicken-breast-boneless-skinless'
  name_en       text not null,
  name_zh       text,
  unit_basis    text not null default '100g'
                check (unit_basis in ('100g', '100ml', 'each')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ─── Categories ────────────────────────────────────────────────────────────
-- Website sections. A product can be in several (chicken breast: Meat + Gym).
create table categories (
  id            bigint generated always as identity primary key,
  slug          text not null unique,             -- 'meat', 'vegetables', 'gym'
  name_en       text not null,
  name_zh       text,
  sort_order    int  not null default 0,          -- display order on the website
  active        boolean not null default true
);

create table product_categories (
  product_id    bigint not null references products(id)   on delete cascade,
  category_id   bigint not null references categories(id) on delete cascade,
  primary key (product_id, category_id)
);

create index product_categories_category_id_idx on product_categories (category_id);

-- ─── Product listings ──────────────────────────────────────────────────────
-- Where to find a tracked product at a given store: the exact page the script
-- checks, so it never has to guess from search results.
create table product_listings (
  id            bigint generated always as identity primary key,
  product_id    bigint not null references products(id) on delete cascade,
  store_id      text   not null references stores(id)   on delete cascade,
  title         text not null,                    -- name as the store shows it
  url           text,                             -- product page, shown to users as the link
  store_sku     text,                             -- e.g. '20826585_KG', '03033201'
  pack_grams    numeric(10,2),                    -- fixed pack weight if known
  sold_by       text check (sold_by in ('each', 'lb', 'kg', '100g')),
  active        boolean not null default true,
  unique (store_id, url)
);

create index product_listings_product_id_idx on product_listings (product_id);

-- ─── Prices ────────────────────────────────────────────────────────────────
-- One row per item per store per day. Never overwritten, so history builds up.
create table prices (
  id              bigint generated always as identity primary key,
  store_id        text   not null references stores(id),
  product_id      bigint references products(id),           -- null = untracked flyer deal
  listing_id      bigint references product_listings(id),
  source          text not null check (source in ('website', 'flipp', 'manual')),
  source_item_id  text not null,                  -- Flipp item id, store SKU, or URL
  item_name       text not null,
  price           numeric(10,2) not null check (price >= 0),
  price_unit      text,                           -- 'ea', 'lb', 'kg', '100g'
  regular_price   numeric(10,2),                  -- "was" price when on sale
  is_sale         boolean not null default false,
  per_unit        numeric(10,3),                  -- price per 100 g / 100 mL (see unit_basis)
  per_unit_max    numeric(10,3),                  -- upper bound when the pack size is a range
  unit_basis      text check (unit_basis in ('100g', '100ml', 'each')),
  conditions      text,                           -- 'LIMIT 4', 'PC Optimum members', '2 for $5'
  valid_from      date,
  valid_to        date,
  url             text,                           -- link for users (Flipp ttm_url or product page)
  needs_review    boolean not null default false, -- flagged by sanity checks
  raw             jsonb,                          -- original payload, for debugging parsers
  observed_on     date not null default current_date,
  checked_at      timestamptz not null default now(),
  unique (store_id, source, source_item_id, observed_on)
);

create index prices_product_latest_idx on prices (product_id, store_id, observed_on desc);
create index prices_store_valid_idx    on prices (store_id, valid_to);
create index prices_listing_id_idx     on prices (listing_id);

-- ─── Scrape runs ───────────────────────────────────────────────────────────
-- One row per script run per source, so the site can show "last checked" and
-- you can spot blocks (e.g. Walmart captcha) without reading logs.
create table scrape_runs (
  id            bigint generated always as identity primary key,
  store_id      text references stores(id),
  source        text not null check (source in ('website', 'flipp', 'manual')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                check (status in ('running', 'ok', 'partial', 'blocked', 'error')),
  items_found   int not null default 0,
  message       text
);

create index scrape_runs_store_started_idx on scrape_runs (store_id, started_at desc);

-- ─── Views for the website ─────────────────────────────────────────────────
-- security_invoker: views respect the caller's RLS instead of bypassing it.

-- Latest known price of each tracked product at each store; when a store has
-- several matches on the same day, the cheapest per 100 g / 100 mL wins.
create view latest_prices
with (security_invoker = true) as
select distinct on (p.product_id, p.store_id)
  p.product_id, pr.slug, pr.name_en, pr.name_zh,
  (select coalesce(array_agg(c.slug order by c.sort_order), '{}')
     from product_categories pc
     join categories c on c.id = pc.category_id
    where pc.product_id = p.product_id and c.active) as categories,
  p.store_id, s.chain, s.name as store_name,
  p.item_name, p.price, p.price_unit, p.regular_price, p.is_sale,
  p.per_unit, p.per_unit_max, p.unit_basis, p.conditions,
  p.valid_from, p.valid_to, p.url, p.source, p.observed_on, p.checked_at
from prices p
join products pr on pr.id = p.product_id
join stores   s  on s.id  = p.store_id
where p.product_id is not null
  and not p.needs_review
  and (p.valid_to is null or p.valid_to >= current_date)
order by p.product_id, p.store_id, p.observed_on desc, p.per_unit asc nulls last, p.price asc;

-- This week's flyer deals (tracked or not) that are still valid.
create view current_deals
with (security_invoker = true) as
select p.*, s.chain, s.name as store_name
from prices p
join stores s on s.id = p.store_id
where p.source = 'flipp'
  and not p.needs_review
  and p.valid_to >= current_date
  and p.observed_on = (select max(observed_on) from prices q
                       where q.store_id = p.store_id and q.source = 'flipp');

-- ─── Row-level security: public can read, only the script can write ────────
alter table stores             enable row level security;
alter table products           enable row level security;
alter table categories         enable row level security;
alter table product_categories enable row level security;
alter table product_listings   enable row level security;
alter table prices             enable row level security;
alter table scrape_runs        enable row level security;

create policy "public read" on stores             for select to anon, authenticated using (true);
create policy "public read" on products           for select to anon, authenticated using (active);
create policy "public read" on categories         for select to anon, authenticated using (active);
create policy "public read" on product_categories for select to anon, authenticated using (true);
create policy "public read" on product_listings   for select to anon, authenticated using (active);
create policy "public read" on prices             for select to anon, authenticated using (true);
create policy "public read" on scrape_runs        for select to anon, authenticated using (true);
-- No insert/update/delete policies: anon/authenticated cannot write.

-- ─── Data API grants ───────────────────────────────────────────────────────
-- Projects created after 2026-05-30 (and all projects from 2026-10-30) no longer
-- expose new tables automatically, so grant explicitly. Older projects auto-grant
-- write privileges to anon/authenticated, so revoke those first: RLS already
-- blocks writes, this is defense in depth.
revoke insert, update, delete, truncate on
  stores, products, categories, product_categories, product_listings, prices, scrape_runs,
  latest_prices, current_deals
  from anon, authenticated;

grant select on
  stores, products, categories, product_categories, product_listings, prices, scrape_runs,
  latest_prices, current_deals
  to anon, authenticated;

grant select, insert, update, delete on
  stores, products, categories, product_categories, product_listings, prices, scrape_runs
  to service_role;
grant select on latest_prices, current_deals to service_role;

-- ─── Starter data (store codes verified Oct 15, 2026) ──────────────────────
insert into stores (id, chain, name, address, postal_code, external_id, website) values
  ('tnt-deerfoot',          'T&T',            'Deerfoot',        '25 Heritage Meadows Way SE',     'T2H 0A7', 'DF',   'https://www.tntsupermarket.com'),
  ('tnt-harvest-hills',     'T&T',            'Harvest Hills',   '9650 Harvest Hills Blvd NE',     'T3K 0B3', 'HH',   'https://www.tntsupermarket.com'),
  ('saveon-heritage',       'Save-On-Foods',  'Heritage',        '#100 - 8855 Macleod Trail SW',   'T2H 0M2', '6634', 'https://www.saveonfoods.com'),
  ('walmart-tsuutina',      'Walmart',        'Tsuu T''ina',     null,                             'T2W 9Z0', '3010', 'https://www.walmart.ca'),
  ('nofrills-calgary',      'No Frills',      'Calgary (flyer)', null,                             'T2P',     null,   'https://www.nofrills.ca'),
  ('superstore-calgary',    'Superstore',     'Calgary (flyer)', null,                             'T2P',     null,   'https://www.realcanadiansuperstore.ca'),
  ('wholesaleclub-calgary', 'Wholesale Club', 'Calgary (flyer)', null,                             'T2P',     null,   'https://www.wholesaleclub.ca'),
  ('freshco-calgary',       'FreshCo',        'Calgary (flyer)', null,                             'T2P',     null,   'https://www.freshco.com'),
  ('costco-calgary',        'Costco',         'Calgary (online)', null,                            'T2P',     null,   'https://www.costco.ca');

insert into categories (slug, name_en, name_zh, sort_order) values
  ('meat',       'Meat',                '肉类',       10),
  ('seafood',    'Seafood',             '海鲜',       20),
  ('vegetables', 'Vegetables',          '蔬菜',       30),
  ('fruit',      'Fruit',               '水果',       40),
  ('dairy-eggs', 'Dairy & Eggs',        '乳制品和蛋', 50),
  ('pantry',     'Pantry',              '主食粮油',   60),
  ('gym',        'Gym',  '健身高蛋白', 70);

insert into products (slug, name_en, name_zh, unit_basis) values
  ('chicken-breast-boneless-skinless', 'Chicken breast, boneless skinless', '去骨去皮鸡胸肉', '100g');

insert into product_categories (product_id, category_id)
select p.id, c.id
from products p
join categories c on c.slug in ('meat', 'gym')
where p.slug = 'chicken-breast-boneless-skinless';

insert into product_listings (product_id, store_id, title, url, store_sku, sold_by)
select p.id, l.store_id, l.title, l.url, l.sku, l.sold_by
from products p
cross join (values
  ('tnt-deerfoot',       'Chicken Breast Skinless Boneless (2.2lb)',
     'https://www.tntsupermarket.com/eng/03033201-chicken-breast-skinless-boneless.html', '03033201', 'lb'),
  ('walmart-tsuutina',   'Maple Leaf Boneless Skinless Chicken Breasts, 6-7 pc, 1.23 - 1.99 KG',
     'https://www.walmart.ca/en/ip/maple-leaf-boneless-skinless-chicken-breasts/3Z4HSOD28G07', '3Z4HSOD28G07', '100g'),
  ('superstore-calgary', 'Chicken Breasts, boneless skinless',
     'https://www.realcanadiansuperstore.ca/p/20826585_KG', '20826585_KG', 'lb')
) as l(store_id, title, url, sku, sold_by)
where p.slug = 'chicken-breast-boneless-skinless';
