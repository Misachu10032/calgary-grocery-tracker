-- Search phrases for every tracked product. Used by both collectors:
-- Flipp search (all flyers + Walmart online catalogue) and Save-On's site search.
-- Each phrase is searched separately; results still pass search/exclude terms.
update products p set website_queries = q.queries
from (values
  ('chicken-breast-boneless-skinless', '{chicken breast,boneless skinless chicken breast}'::text[]),
  ('chicken-thighs',  '{chicken thighs,boneless skinless chicken thighs}'::text[]),
  ('chicken-legs',    '{chicken drumsticks,chicken legs}'::text[]),
  ('ground-beef',     '{lean ground beef,ground beef}'::text[]),
  ('rib-eye',         '{rib eye steak,ribeye}'::text[]),
  ('sirloin',         '{sirloin steak,top sirloin}'::text[]),
  ('bok-choy',        '{bok choy,shanghai bok choy}'::text[]),
  ('napa-cabbage',    '{napa cabbage,suey choy}'::text[]),
  ('spinach',         '{spinach,baby spinach}'::text[]),
  ('eggplant',        '{eggplant,chinese eggplant}'::text[]),
  ('broccoli',        '{broccoli,broccoli crowns}'::text[]),
  ('carrots',         '{carrots}'::text[]),
  ('cauliflower',     '{cauliflower}'::text[]),
  ('tomatoes',        '{tomatoes,roma tomatoes,tomatoes on the vine}'::text[]),
  ('oranges',         '{navel oranges,oranges}'::text[]),
  ('bananas',         '{bananas}'::text[]),
  ('pears',           '{pears,bartlett pears,asian pears}'::text[])
) as q(slug, queries)
where p.slug = q.slug;

-- Some store searches (T&T) treat singular and plural differently: add both.
update products p set website_queries = p.website_queries || q.extra
from (values
  ('carrots',        '{carrot}'::text[]),
  ('pears',          '{pear}'::text[]),
  ('bananas',        '{banana}'::text[]),
  ('oranges',        '{orange}'::text[]),
  ('tomatoes',       '{tomato}'::text[]),
  ('chicken-thighs', '{chicken thigh}'::text[]),
  ('chicken-legs',   '{chicken drumstick,chicken leg}'::text[]),
  ('ground-beef',    '{minced beef}'::text[]),
  ('sirloin',        '{sirloin}'::text[]),
  ('eggplant',       '{egg plant}'::text[])
) as q(slug, extra)
where p.slug = q.slug;

-- Store websites list many prepared variants; keep comparisons to plain products.
update products set exclude_terms = exclude_terms || '{teriyaki,marinated,seasoned,bbq,barbecue,garlic,herb,glazed,cajun,souvlaki,pinty,butter chicken,tikka}'::text[]
 where slug in ('chicken-breast-boneless-skinless','chicken-thighs','chicken-legs');
update products set exclude_terms = exclude_terms || '{spring mix,mix,blend}'::text[] where slug = 'spinach';
