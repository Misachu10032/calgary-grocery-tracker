-- Optional product photo. Empty = the website shows a category placeholder.
-- A file in web/public/products/<slug>.(jpg|png|webp) is used when this is empty.
alter table products add column image_url text;

comment on column products.image_url is 'Optional photo URL; when empty the site uses web/public/products/<slug>.* or a placeholder.';
