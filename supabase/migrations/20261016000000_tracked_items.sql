-- Tracked item list + fuzzy matching terms for flyer/website names.
--
-- Matching rule (implemented in the price script):
--   normalise both sides: lowercase, '-' and '_' → space, collapse whitespace;
--   an item matches when ANY search term appears in the name/description
--   AND NO exclude term appears.
-- Keep terms short and generic so store wording ("Rib-Eye Grilling Steak",
-- "SUEY CHOY") still matches; add excludes for look-alikes (sauces, breaded…).

alter table products
  add column search_terms  text[] not null default '{}',
  add column exclude_terms text[] not null default '{}';

comment on column products.search_terms  is 'Match if ANY term appears in the normalised item name (lowercase, hyphens → spaces).';
comment on column products.exclude_terms is 'Reject if ANY term appears; filters look-alikes such as sauces, breaded or frozen items.';

-- Chicken breast already exists from the initial seed: add terms, and follow the
-- user's list (Meat only, not Gym).
update products set
  search_terms  = '{chicken breast,breast fillet,boneless skinless breast,鸡胸}',
  exclude_terms = '{breaded,battered,nugget,strip,finger,popcorn,smoked,deli,shaved,sliced,cooked,roasted,rotisserie,stuffed,kabob,kebab,burger,soup,broth,cat,dog}'
where slug = 'chicken-breast-boneless-skinless';

delete from product_categories pc
using products p, categories c
where pc.product_id = p.id and pc.category_id = c.id
  and p.slug = 'chicken-breast-boneless-skinless' and c.slug = 'gym';

insert into products (slug, name_en, name_zh, unit_basis, search_terms, exclude_terms) values
  -- Vegetables (fresh only)
  ('bok-choy',      'Bok choy',      '上海青 / 小白菜', '100g',
     '{bok choy,bok choi,bokchoy,pak choi,pak choy,pok choi,shanghai choy,shanghai bok,baby bok,上海青,小白菜,白菜仔,青江菜}',
     '{frozen,kimchi,salad kit,soup,dumpling,noodle}'),
  ('napa-cabbage',  'Napa cabbage',  '大白菜',          '100g',
     '{napa,nappa,suey choy,sui choy,siu choy,chinese cabbage,wong bok,baby napa,大白菜,黄芽白,娃娃菜}',
     '{kimchi,coleslaw,slaw,salad kit,dumpling,frozen}'),
  ('spinach',       'Spinach',       '菠菜',            '100g',
     '{spinach,菠菜}',
     '{frozen,dip,artichoke,pasta,ravioli,tortellini,wrap,tortilla,pie,spanakopita,salad kit,quiche,noodle,juice,smoothie,pinwheel,feta,puff,pastry,roll}'),
  ('eggplant',      'Eggplant',      '茄子',            '100g',
     '{eggplant,egg plant,aubergine,茄子}',
     '{parmesan,parmigiana,dip,baba,ghanouj,frozen,breaded,grilled,sauce}'),
  ('broccoli',      'Broccoli',      '西兰花',          '100g',
     '{broccoli,西兰花,西蓝花}',
     '{broccolini,chinese broccoli,gai lan,slaw,salad,frozen,cheese,soup,rice,tots,bites,stir fry}'),
  ('carrots',       'Carrots',       '胡萝卜',          '100g',
     '{carrot,胡萝卜,红萝卜}',
     '{cake,muffin,juice,baby food,puree,soup,frozen,mixed vegetable,peas and carrot,dip,chips}'),
  ('cauliflower',   'Cauliflower',   '花菜',            '100g',
     '{cauliflower,花菜,菜花,花椰菜}',
     '{rice,riced,pizza,crust,bites,tots,frozen,mash,gnocchi,wings,soup,pickled}'),
  ('tomatoes',      'Tomatoes',      '番茄',            '100g',
     '{tomato,tomatoe,roma tomato,on the vine,番茄,西红柿}',
     '{sauce,paste,canned,diced,crushed,stewed,puree,passata,ketchup,juice,soup,sun dried,salsa,pasta,pizza,chili,bruschetta,ml,frozen,seeds,plant}'),

  -- Fruit (fresh only)
  ('oranges',       'Oranges',       '橙子',            '100g',
     '{orange,navel,valencia,cara cara,blood orange,橙子,橙}',
     '{juice,chicken,marmalade,mandarin,clementine,tangerine,drink,soda,crush,fanta,flavour,flavor,chocolate,peel,bell pepper,sweet potato,yogurt,frozen,emergen c,vitamin,tablet,candy,gum,tea,pekoe,cookie,scookie,scone,cake,loaf,muffin}'),
  ('bananas',       'Bananas',       '香蕉',            '100g',
     '{banana,香蕉}',
     '{bread,chip,plantain,muffin,split,flavour,flavor,yogurt,baby food,puree,pudding,frozen,boat,pepper,pie,cream}'),
  ('pears',         'Pears',         '梨',              '100g',
     '{pear,bartlett,bosc,anjou,d anjou,nashi,asian pear,ya pear,梨,鸭梨,雪梨}',
     '{juice,cup,canned,nectar,prickly,baby food,puree,cider,frozen,syrup,pearl}'),

  -- Meat (raw cuts; prepared foods excluded)
  ('chicken-thighs','Chicken thighs','鸡腿肉',          '100g',
     '{chicken thigh,thigh,鸡腿肉,鸡扒,去骨鸡腿}',
     '{breaded,battered,nugget,cooked,roasted,rotisserie,smoked,deli,wing,kabob,kebab,burger,soup,cat,dog,turkey,slimmer,shaper,women,legging,pant,sock}'),
  ('chicken-legs',  'Chicken legs / drumsticks', '鸡腿', '100g',
     '{chicken leg,drumstick,leg quarter,leg back,whole leg,鸡腿,琵琶腿,鸡全腿}',
     '{breaded,battered,cooked,roasted,rotisserie,smoked,wing,turkey,duck,lamb,frog,crab,cat,dog,ice cream,nestle,cone,haagen,häagen}'),
  ('ground-beef',   'Ground beef',   '牛肉碎',          '100g',
     '{ground beef,lean ground,extra lean ground,medium ground,regular ground,ground chuck,ground sirloin,ground round,minced beef,beef mince,牛肉碎,牛绞肉,牛肉馅}',
     '{patty,patties,burger,meatball,chicken,turkey,pork,veal,lamb,bison,plant,beyond,impossible,sauce,lasagna,chili,taco kit}'),
  ('rib-eye',       'Rib eye steak', '肉眼牛排',        '100g',
     '{rib eye,ribeye,rib steak,肉眼}',
     '{pork,seasoning,sauce,rub,marinade,frozen dinner,sandwich,roll,shabu,hot pot,hotpot}'),
  ('sirloin',       'Sirloin steak', '西冷牛排',        '100g',
     '{sirloin,西冷}',
     '{pork,ground,burger,patty,seasoning,sauce,rub,marinade,sandwich}'),

  -- Gym (drinks per 100 mL, protein per 100 g)
  ('monster-energy','Monster energy drink', 'Monster 能量饮料', '100ml',
     '{monster energy,monster ultra,monster zero,java monster,monster rehab,monster juice,monster reserve,monster}',
     '{cookie,monster truck,monster jam,toy,costume,cereal,mash,high,truck,robo,rc}'),
  ('alani-energy',  'Alani Nu energy drink', 'Alani 能量饮料', '100ml',
     '{alani nu,alani}',
     '{protein,whey,pre workout,preworkout,bar,cereal,gummy,capsule,powder}'),
  ('optimum-nutrition', 'Optimum Nutrition protein', 'Optimum Nutrition 蛋白粉', '100g',
     '{optimum nutrition,gold standard whey,gold standard 100,gold standard isolate,gold standard plant,on gold standard}',
     '{bar,amino energy,shaker,creatine,pre workout,preworkout,bcaa,gummy}'),
  ('nuage-protein', 'NuAge protein', 'NuAge 蛋白', '100g',
     '{nuage,nu age,nu-age}',
     '{shaker,bottle,capsule}');

insert into product_categories (product_id, category_id)
select p.id, c.id
from (values
  ('bok-choy','vegetables'), ('napa-cabbage','vegetables'), ('spinach','vegetables'), ('eggplant','vegetables'),
  ('broccoli','vegetables'), ('carrots','vegetables'), ('cauliflower','vegetables'), ('tomatoes','vegetables'),
  ('oranges','fruit'), ('bananas','fruit'), ('pears','fruit'),
  ('chicken-thighs','meat'), ('chicken-legs','meat'), ('ground-beef','meat'), ('rib-eye','meat'), ('sirloin','meat'),
  ('monster-energy','gym'), ('alani-energy','gym'), ('optimum-nutrition','gym'), ('nuage-protein','gym')
) as m(product_slug, category_slug)
join products   p on p.slug = m.product_slug
join categories c on c.slug = m.category_slug;
