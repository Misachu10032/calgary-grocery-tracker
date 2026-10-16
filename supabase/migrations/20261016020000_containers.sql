-- Energy drinks are compared per container (can/bottle) with its size shown,
-- instead of per 100 mL. Also stores search phrases for store-website collectors.

alter table products drop constraint products_unit_basis_check;
alter table products add constraint products_unit_basis_check
  check (unit_basis in ('100g', '100ml', 'each', 'container'));

alter table prices drop constraint prices_unit_basis_check;
alter table prices add constraint prices_unit_basis_check
  check (unit_basis in ('100g', '100ml', 'each', 'container'));

alter table prices
  add column pack_count     int check (pack_count > 0),   -- containers in the pack (1 = single)
  add column container_size numeric(10,2),               -- size of one container, e.g. 473
  add column container_unit text check (container_unit in ('ml', 'g'));

comment on column prices.per_unit is
  'Price per 100 g / 100 mL, or per container when unit_basis = container.';

-- Store websites return few results per search, so each product lists the
-- phrases to search for (empty = not collected from websites).
alter table products add column website_queries text[] not null default '{}';

update products set unit_basis = 'container',
  website_queries = '{monster energy drink,monster energy,monster ultra,monster original,monster zero sugar,monster juice}'
where slug = 'monster-energy';

update products set unit_basis = 'container',
  website_queries = '{alani nu energy,alani nu}'
where slug = 'alani-energy';

update products set website_queries = '{gold standard whey,optimum nutrition whey,optimum nutrition}'
where slug = 'optimum-nutrition';

update products set website_queries = '{nuage protein,nuage}'
where slug = 'nuage-protein';

-- Expose the container columns to the website (new columns go at the end).
create or replace view latest_prices
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
  p.valid_from, p.valid_to, p.url, p.source, p.observed_on, p.checked_at,
  p.pack_count, p.container_size, p.container_unit
from prices p
join products pr on pr.id = p.product_id
join stores   s  on s.id  = p.store_id
where p.product_id is not null
  and not p.needs_review
  and (p.valid_to is null or p.valid_to >= current_date)
order by p.product_id, p.store_id, p.observed_on desc, p.per_unit asc nulls last, p.price asc;
