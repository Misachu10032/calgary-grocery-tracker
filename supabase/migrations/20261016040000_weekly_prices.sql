-- Price history for the website's week picker: the best price of each tracked
-- product at each store, per week (weeks start on Monday). Prices are never
-- overwritten, so every weekly collector run adds a week of history.
create view weekly_prices
with (security_invoker = true) as
select distinct on (p.product_id, p.store_id, date_trunc('week', p.observed_on))
  date_trunc('week', p.observed_on)::date as week_start,
  p.product_id, p.store_id, s.chain, s.name as store_name,
  p.item_name, p.price, p.price_unit, p.regular_price, p.is_sale,
  p.per_unit, p.per_unit_max, p.unit_basis, p.conditions,
  p.valid_from, p.valid_to, p.url, p.source, p.observed_on, p.checked_at,
  p.pack_count, p.container_size, p.container_unit
from prices p
join stores s on s.id = p.store_id
where p.product_id is not null
  and not p.needs_review
order by p.product_id, p.store_id, date_trunc('week', p.observed_on),
         p.observed_on desc, p.per_unit asc nulls last, p.price asc;

-- Read-only for the website, like latest_prices.
revoke insert, update, delete, truncate on weekly_prices from anon, authenticated;
grant select on weekly_prices to anon, authenticated, service_role;

create index if not exists prices_week_lookup_idx on prices (observed_on, product_id, store_id);
