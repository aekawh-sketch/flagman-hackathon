// ═══════════════════════════════════════════════════════════════
//  ИСТОК — справочники для склада: продукты и техкарты (рецептуры)
//
//  ⚠ Количества в техкартах — ПРИМЕРНЫЕ (собраны по описаниям блюд).
//    Перед боевым запуском их нужно сверить с реальными ТТК кухни.
//
//  Эти же данные выгружаются в /backend-seed/*.json (см. BACKEND_PLAN.md),
//  чтобы бэкенд стартовал с той же базой, что и демо-режим фронта.
// ═══════════════════════════════════════════════════════════════

/** Группы продуктов (для фильтров на складе) */
export const PRODUCT_GROUPS = {
  meat: 'Мясо',
  poultry: 'Птица',
  fish: 'Рыба и морепродукты',
  dairy: 'Молочное и сыры',
  veg: 'Овощи и зелень',
  grocery: 'Бакалея и заготовки',
  bakery: 'Хлеб и тесто',
  sauce: 'Соусы',
  drinks: 'Напитки и сиропы',
};

/**
 * Продукты: id, name, unit (g | ml | pcs), shelf (срок годности, часы),
 * group, cost (₽ за кг / л / шт), pack (кратность закупки, в unit)
 */
export const PRODUCTS = [
  // Мясо
  ['pork_patty',   'Котлета свиная',         'pcs', 96,   'meat',    55,   20],
  ['beef_patty',   'Котлета говяжья',        'pcs', 72,   'meat',    85,   20],
  ['bacon',        'Бекон',                  'g',   168,  'meat',    780,  1000],
  ['minced_meat',  'Фарш свино-говяжий',     'g',   48,   'meat',    520,  2000],
  ['pork',         'Свинина томлёная',       'g',   72,   'meat',    560,  2000],
  ['ribs',         'Рёбра свиные',           'g',   72,   'meat',    490,  3000],
  ['ham',          'Ветчина',                'g',   168,  'meat',    610,  1000],
  ['pepperoni',    'Пепперони',              'g',   480,  'meat',    980,  1000],
  // Птица
  ['chicken_fillet','Куриное филе',          'g',   72,   'poultry', 420,  2000],
  ['smoked_chicken','Курица копчёная',       'g',   168,  'poultry', 640,  1000],
  ['chicken_patty','Котлета куриная',        'pcs', 96,   'poultry', 45,   20],
  ['schnitzel',    'Шницель куриный',        'pcs', 96,   'poultry', 60,   20],
  ['nuggets',      'Наггетсы (зам.)',        'g',   720,  'poultry', 460,  2000],
  ['wings',        'Куриные крылья',         'g',   72,   'poultry', 330,  2000],
  // Рыба и морепродукты
  ['salmon',       'Лосось',                 'g',   72,   'fish',    1900, 1000],
  ['shrimp',       'Креветки',               'g',   96,   'fish',    1500, 1000],
  ['crab_mix',     'Крабовый замес',         'g',   72,   'fish',    620,  1000],
  ['seafood_mix',  'Морской коктейль',       'g',   96,   'fish',    980,  1000],
  ['masago',       'Икра масаго',            'g',   336,  'fish',    2400, 500],
  // Молочное и сыры
  ['gouda',        'Сыр гауда',              'g',   336,  'dairy',   890,  1000],
  ['cheddar',      'Сыр чеддер',             'g',   336,  'dairy',   950,  1000],
  ['mozzarella',   'Моцарелла',              'g',   240,  'dairy',   820,  2000],
  ['parmesan',     'Пармезан',               'g',   720,  'dairy',   1900, 500],
  ['dorblu',       'Сыр дор блю',            'g',   504,  'dairy',   2300, 500],
  ['cream_cheese', 'Сливочный сыр',          'g',   240,  'dairy',   990,  1000],
  ['feta',         'Брынза',                 'g',   240,  'dairy',   720,  1000],
  ['cottage',      'Творог',                 'g',   120,  'dairy',   420,  1000],
  ['milk',         'Молоко 3,2%',            'ml',  120,  'dairy',   95,   1000],
  ['alt_milk',     'Альтернативное молоко',  'ml',  720,  'dairy',   330,  1000],
  ['cream',        'Сливки 33%',             'ml',  168,  'dairy',   520,  1000],
  ['eggs',         'Яйцо куриное',           'pcs', 504,  'dairy',   11,   30],
  ['ice_cream',    'Мороженое пломбир',      'g',   1440, 'dairy',   480,  1000],
  // Овощи и зелень
  ['tomato',       'Томаты',                 'g',   120,  'veg',     260,  3000],
  ['cucumber',     'Огурцы свежие',          'g',   144,  'veg',     210,  2000],
  ['pickles',      'Огурцы солёные',         'g',   720,  'veg',     240,  2000],
  ['lettuce',      'Салат айсберг',          'g',   96,   'veg',     480,  1000],
  ['onion',        'Лук репчатый',           'g',   480,  'veg',     45,   5000],
  ['red_onion',    'Лук красный',            'g',   480,  'veg',     75,   2000],
  ['mushrooms',    'Шампиньоны',             'g',   96,   'veg',     390,  2000],
  ['bell_pepper',  'Перец болгарский',       'g',   168,  'veg',     380,  2000],
  ['jalapeno',     'Халапеньо',              'g',   720,  'veg',     690,  1000],
  ['cabbage',      'Капуста пекинская',      'g',   168,  'veg',     140,  2000],
  ['carrot',       'Морковь',                'g',   336,  'veg',     55,   3000],
  ['zucchini',     'Кабачок',                'g',   168,  'veg',     160,  2000],
  ['herbs',        'Зелень (укроп, кинза)',  'g',   72,   'veg',     900,  300],
  ['olives',       'Маслины',                'g',   1440, 'veg',     640,  1000],
  ['pineapple',    'Ананас конс.',           'g',   720,  'veg',     330,  1000],
  ['corn',         'Кукуруза конс.',         'g',   720,  'veg',     260,  1000],
  ['berries',      'Ягоды (клубника, малина)','g',  72,   'veg',     780,  1000],
  ['orange',       'Апельсины',              'g',   336,  'veg',     160,  5000],
  // Бакалея и заготовки
  ['rice',         'Рис для суши',           'g',   4320, 'grocery', 190,  5000],
  ['nori',         'Нори (лист)',            'pcs', 4320, 'grocery', 9,    100],
  ['noodles',      'Лапша фунчоза/удон',     'g',   4320, 'grocery', 380,  2000],
  ['pasta',        'Паста',                  'g',   8640, 'grocery', 170,  3000],
  ['fries',        'Картофель фри (зам.)',   'g',   2160, 'grocery', 210,  5000],
  ['wedges',       'Картофельные дольки (зам.)','g',2160, 'grocery', 230,  5000],
  ['onion_rings',  'Луковые кольца (зам.)',  'g',   2160, 'grocery', 520,  2000],
  ['tapioca',      'Тапиока (шарики)',       'g',   720,  'grocery', 650,  1000],
  ['croutons',     'Крутоны',                'g',   720,  'grocery', 420,  500],
  ['coffee',       'Кофе в зёрнах',          'g',   1440, 'grocery', 1800, 1000],
  ['tea',          'Чай листовой / матча',   'g',   4320, 'grocery', 1400, 500],
  ['cocoa',        'Какао',                  'g',   4320, 'grocery', 900,  1000],
  // Хлеб и тесто
  ['bun',          'Булочка для бургера',    'pcs', 72,   'bakery',  22,   30],
  ['lavash',       'Лаваш',                  'pcs', 120,  'bakery',  18,   30],
  ['pizza_dough',  'Тесто для пиццы',        'g',   72,   'bakery',  90,   5000],
  // Соусы
  ['sauce_house',  'Соус фирменный',         'ml',  336,  'sauce',   350,  1000],
  ['sauce_bbq',    'Соус барбекю',           'ml',  1440, 'sauce',   290,  1000],
  ['sauce_caesar', 'Соус цезарь',            'ml',  240,  'sauce',   420,  1000],
  ['sauce_cheese', 'Соус сырный',            'ml',  336,  'sauce',   460,  1000],
  ['sauce_spicy',  'Соус спайс / шрирача',   'ml',  720,  'sauce',   480,  1000],
  ['sauce_teriyaki','Соус терияки / унаги',  'ml',  1440, 'sauce',   390,  1000],
  ['sauce_tomato', 'Соус томатный',          'ml',  336,  'sauce',   210,  1000],
  ['sauce_cream',  'Соус сливочный',         'ml',  168,  'sauce',   430,  1000],
  ['bolognese',    'Соус болоньезе',         'ml',  96,   'sauce',   520,  2000],
  // Напитки и сиропы
  ['syrup',        'Сиропы (ассорти)',       'ml',  2160, 'drinks',  480,  1000],
  ['fruit_puree',  'Фруктовое пюре',         'ml',  240,  'drinks',  640,  1000],
  ['lemonade_base','Основа для лимонада',    'ml',  720,  'drinks',  160,  5000],
].map(([id, name, unit, shelf, group, cost, pack]) => ({ id, name, unit, shelf_hours: shelf, group, cost, pack }));

export const PRODUCT_BY_ID = Object.fromEntries(PRODUCTS.map(p => [p.id, p]));

// ── Техкарты ───────────────────────────────────────────────────
// Формат: 'product:qty product:qty …' — на 1 порцию базового размера.
// sizeFactor для второго размера = price2 / price (см. engine.requirement).
const R = {
  // Бургеры
  b1:  'bun:1 pork_patty:1 bacon:30 gouda:20 cheddar:20 onion_rings:30 tomato:30 pickles:20 sauce_house:25 sauce_spicy:15',
  b2:  'bun:1 pork_patty:1 bacon:30 bolognese:40 gouda:20 tomato:30 pickles:20 onion:15 lettuce:10',
  b3:  'bun:1 schnitzel:1 tomato:30 pickles:20 red_onion:15 sauce_house:35',
  b4:  'bun:1 pork_patty:1 gouda:20 tomato:30 pickles:15 lettuce:10 sauce_house:25',
  b5:  'bun:1 pork_patty:1 bacon:30 gouda:20 tomato:30 pickles:20 onion:15 sauce_bbq:25',
  b6:  'bun:1 beef_patty:1 pork:60 bacon:30 gouda:20 tomato:30 lettuce:10 onion:15 sauce_bbq:20',
  b7:  'bun:1 pork_patty:1 bacon:30 gouda:20 mushrooms:40 fries:40 tomato:30 pickles:20 lettuce:10 onion:15 sauce_house:15 sauce_caesar:15',
  b8:  'bun:1 pork_patty:1 cheddar:50 gouda:20 tomato:30 pickles:20 lettuce:10 sauce_house:20',
  b9:  'bun:1 pork_patty:1 gouda:20 tomato:30 onion:30 jalapeno:20 sauce_bbq:20 sauce_spicy:10',
  b10: 'bun:1 pork_patty:1 gouda:20 mozzarella:20 dorblu:25 tomato:30 pickles:20 sauce_cheese:20',
  b11: 'bun:1 pork_patty:2 bacon:30 gouda:30 tomato:30 pickles:20 lettuce:10 onion:15 sauce_house:25',
  b12: 'bun:1 pork_patty:3 bacon:40 gouda:30 tomato:30 onion:15 pickles:20 lettuce:10 sauce_house:30',
  b13: 'bun:1 chicken_patty:1 gouda:20 tomato:30 cucumber:30 lettuce:10 onion:15 sauce_caesar:25',
  b14: 'bun:1 chicken_patty:1 bacon:30 gouda:20 cheddar:20 tomato:30 pickles:20 sauce_house:25',
  b15: 'bun:1 beef_patty:1 cheddar:20 bacon:30 pickles:20 tomato:30 jalapeno:15 red_onion:15 sauce_caesar:15',
  b16: 'bun:1 shrimp:80 cheddar:20 gouda:20 pickles:20 tomato:30 zucchini:30 sauce_house:20',
  // Шаурма и гирос
  nb1: 'lavash:1 chicken_fillet:120 tomato:40 cucumber:40 carrot:30 onion:15 cabbage:40 sauce_house:40',
  nb2: 'lavash:1 ribs:120 pickles:30 cabbage:40 onion:15 jalapeno:15 sauce_house:40',
  nb3: 'lavash:1 pork:120 tomato:40 pickles:30 cabbage:40 carrot:30 onion:15 sauce_bbq:20 sauce_caesar:20',
  nb4: 'lavash:1 chicken_fillet:150 tomato:50 cucumber:50 fries:100 onion:20 sauce_house:40',
  nb5: 'chicken_fillet:150 tomato:50 cucumber:50 fries:120 onion:20 sauce_house:40',
  // Закуски
  sn1: 'fries:150',
  sn2: 'wedges:150',
  sn3: 'wedges:200 minced_meat:100 sauce_bbq:30',
  sn4: 'mozzarella:150 berries:20',
  sn5: 'nuggets:150 sauce_bbq:20',
  sn6: 'wings:250 sauce_bbq:20',
  sn7: 'onion_rings:170',
  // Салаты
  sal1: 'chicken_fillet:80 tomato:40 lettuce:50 parmesan:15 sauce_caesar:30 croutons:15',
  sal2: 'salmon:70 tomato:40 lettuce:50 parmesan:15 sauce_caesar:30 croutons:15',
  sal3: 'tomato:80 cucumber:80 lettuce:30 herbs:10 onion:20',
  sal4: 'chicken_fillet:80 mushrooms:60 wedges:60 tomato:40 lettuce:30 sauce_house:20',
  sal5: 'tomato:70 cucumber:70 feta:50 olives:20 onion:20',
  // Супы
  sp1: 'shrimp:50 seafood_mix:40 mushrooms:40 cream:100 sauce_spicy:20 tomato:30',
  sp2: 'ham:50 pork:40 pickles:40 olives:15 sauce_tomato:30 onion:20',
  sp3: 'mushrooms:120 cream:100 onion:20 croutons:10',
  // Пицца (30 см; 40 см — ×price2/price)
  pz1:  'pizza_dough:250 bolognese:80 mozzarella:80 gouda:40 tomato:40 herbs:5 sauce_bbq:15',
  pz2:  'pizza_dough:250 parmesan:30 mozzarella:100 dorblu:40 cheddar:40 sauce_cream:60',
  pz3:  'pizza_dough:250 chicken_fillet:100 sauce_cream:60 mozzarella:100 tomato:40',
  pz4:  'pizza_dough:250 minced_meat:80 bacon:40 sauce_house:30 sauce_bbq:20 mozzarella:90 gouda:30 tomato:40 jalapeno:15',
  pz5:  'pizza_dough:250 minced_meat:80 bacon:40 sauce_house:40 mozzarella:100 bell_pepper:40 pickles:30 red_onion:20',
  pz6:  'pizza_dough:250 chicken_fillet:80 bacon:40 sauce_house:30 sauce_caesar:20 mozzarella:100 tomato:40',
  pz7:  'pizza_dough:250 ham:90 sauce_house:40 mozzarella:100 tomato:50 mushrooms:40',
  pz8:  'pizza_dough:250 pepperoni:40 sauce_tomato:50 ham:40 mozzarella:90 dorblu:25 tomato:30 mushrooms:30 bell_pepper:30',
  pz9:  'pizza_dough:250 smoked_chicken:100 mozzarella:100 mushrooms:40 tomato:40 sauce_house:40',
  pz10: 'pizza_dough:250 smoked_chicken:90 sauce_house:30 mozzarella:100 pineapple:60 tomato:30',
  pz11: 'pizza_dough:250 chicken_fillet:70 bacon:40 sauce_cream:60 mozzarella:100 mushrooms:40 red_onion:20',
  pz12: 'pizza_dough:250 pepperoni:70 mozzarella:110 mushrooms:40 sauce_tomato:50',
  pz13: 'pizza_dough:250 seafood_mix:100 mozzarella:100 tomato:40 olives:20 sauce_house:30',
  pz14: 'pizza_dough:250 salmon:90 tomato:40 mozzarella:90 dorblu:30 sauce_house:30',
  pz15: 'pizza_dough:200 ham:50 bacon:30 pork:40 mozzarella:80 parmesan:15 herbs:5',
  pz16: 'pizza_dough:200 salmon:50 shrimp:50 mozzarella:80 sauce_house:20 herbs:5',
  pz17: 'pizza_dough:200 ham:60 bacon:30 mushrooms:50 mozzarella:80 parmesan:15',
  // Холодные роллы
  rc1:  'rice:70 nori:1 shrimp:40',
  rc2:  'rice:70 nori:1 salmon:40',
  rc3:  'rice:70 nori:1 cucumber:40',
  rc4:  'rice:110 nori:1 crab_mix:60 cucumber:30 masago:15',
  rc5:  'rice:110 nori:1 shrimp:40 cucumber:30 crab_mix:30 masago:15',
  rc6:  'rice:110 nori:1 salmon:50 cucumber:30 crab_mix:30 masago:15',
  rc7:  'rice:110 nori:1 salmon:50 cucumber:30 cream_cheese:40 masago:15 sauce_teriyaki:15',
  rc8:  'rice:110 nori:1 shrimp:50 cucumber:30 cream_cheese:40 sauce_spicy:15',
  rc9:  'rice:110 nori:1 salmon:70 cucumber:30 cream_cheese:50',
  rc10: 'cottage:180 eggs:1 cream:30 berries:20',
  // Горячие роллы
  rh1:  'rice:110 nori:1 smoked_chicken:50 tomato:30 sauce_house:15 lettuce:10 sauce_caesar:20',
  rh2:  'rice:110 nori:1 seafood_mix:40 shrimp:30 cucumber:30 sauce_teriyaki:15 cream_cheese:30 sauce_cheese:20',
  rh3:  'rice:110 nori:1 shrimp:40 cucumber:30 masago:15 crab_mix:30 sauce_house:20',
  rh4:  'rice:110 nori:1 salmon:50 cucumber:30 masago:15 crab_mix:30 sauce_house:20',
  rh5:  'rice:110 nori:1 salmon:50 cucumber:30 cream_cheese:30 bell_pepper:20 sauce_house:15 sauce_teriyaki:15',
  rh6:  'rice:110 nori:1 crab_mix:60 cucumber:30 sauce_spicy:15 sauce_teriyaki:15 sauce_cheese:15 masago:10',
  rh7:  'rice:110 nori:1 salmon:60 cucumber:30 cream_cheese:40 sauce_house:20',
  rh8:  'rice:110 nori:1 crab_mix:40 shrimp:30 cream_cheese:40 sauce_cheese:20',
  rh9:  'rice:110 nori:1 smoked_chicken:40 bacon:25 cream_cheese:30 cucumber:30 sauce_teriyaki:15',
  rh10: 'rice:110 nori:1 smoked_chicken:50 bell_pepper:20 lettuce:10 cucumber:30 cream_cheese:30 sauce_house:15',
  rh11: 'rice:110 nori:1 shrimp:40 cucumber:30 cream_cheese:40',
  rh12: 'rice:110 nori:1 crab_mix:60 cucumber:30 sauce_teriyaki:15 sauce_spicy:15 herbs:5',
  // Основное
  mn1:  'pasta:100 bacon:50 parmesan:20 cream:80 eggs:1',
  mn2:  'pasta:100 seafood_mix:100 parmesan:20 cream:80',
  mn3:  'pasta:100 bolognese:120 parmesan:20',
  mn4:  'rice:150 seafood_mix:100 eggs:1 zucchini:40 bell_pepper:30 carrot:30 onion:20 herbs:5 sauce_teriyaki:20 sauce_spicy:10',
  mn5:  'rice:150 shrimp:80 corn:30 tomato:40 cucumber:40 masago:15 nori:1 sauce_house:15 sauce_teriyaki:15',
  mn6:  'rice:150 chicken_fillet:90 corn:30 tomato:40 cucumber:40 masago:15 nori:1 sauce_house:15 sauce_teriyaki:15',
  mn7:  'noodles:100 chicken_fillet:100 zucchini:40 carrot:30 cabbage:40 onion:20 herbs:5 sauce_teriyaki:20 sauce_spicy:10',
  mn8:  'noodles:100 seafood_mix:100 zucchini:40 carrot:30 cabbage:40 herbs:5 onion:20 cream:50 sauce_teriyaki:20',
  mn9:  'ribs:350 pickles:40 jalapeno:15 red_onion:20 sauce_bbq:40',
  mn10: 'beef_patty:1 wedges:150 eggs:1 sauce_caesar:20 herbs:5',
  // Напитки
  dr1:  'coffee:18 milk:200 fruit_puree:30 syrup:15',
  dr2:  'tea:5 cream:40 fruit_puree:40 syrup:15',
  dr3:  'coffee:18 milk:200 cocoa:15 tapioca:50 cream:30',
  dr4:  'cocoa:25 milk:250 fruit_puree:30 syrup:15',
  dr5:  'tea:6 milk:220 tapioca:50 cream:30 berries:20',
  dr6:  'coffee:18 milk:200 tapioca:50 syrup:20 cream:30',
  dr7:  'lemonade_base:250 syrup:25 fruit_puree:20',
  dr8:  'tea:5 syrup:20 berries:30',
  dr9:  'lemonade_base:250 fruit_puree:30 syrup:15',
  dr10: 'lemonade_base:250 fruit_puree:40 syrup:15',
  dr11: 'coffee:9',
  dr12: 'coffee:18',
  dr13: 'coffee:18 milk:150',
  dr14: 'coffee:18 alt_milk:150',
  dr15: 'coffee:18 milk:150',
  dr16: 'coffee:20 milk:120',
  dr17: 'coffee:18 milk:220',
  dr18: 'coffee:18 cream:150 syrup:15',
  dr19: 'cocoa:25 milk:250 syrup:10',
  dr20: 'tea:5',
  dr21: 'tea:5 fruit_puree:40 syrup:15',
  dr22: 'tea:5 fruit_puree:40 berries:20',
  dr23: 'tea:5 fruit_puree:50 syrup:10',
  dr24: 'fruit_puree:80 berries:40 syrup:15',
  dr25: 'milk:200 ice_cream:120',
  dr26: 'milk:200 ice_cream:120 cocoa:20',
  dr27: 'milk:200 ice_cream:120 berries:40',
  dr28: 'coffee:18 tapioca:50 fruit_puree:40',
  dr40: 'tea:5 berries:40 syrup:15',
  dr41: 'tea:5 tapioca:50 syrup:20 milk:100',
  dr42: 'orange:350',
  dr43: 'tea:5 orange:120 syrup:10',
  dr44: 'tea:5 berries:50 syrup:15',
  dr45: 'coffee:18 milk:200 cream:40 syrup:10',
  dr46: 'tea:5 milk:150 syrup:20',
  dr47: 'cocoa:25 milk:200 tapioca:50',
  dr48: 'coffee:18 milk:150 ice_cream:100 cocoa:15',
  dr49: 'coffee:18 milk:150 ice_cream:80 cream_cheese:30 cocoa:10',
  dr50: 'tea:6 milk:200 tapioca:50',
  dr51: 'coffee:18 milk:200 tapioca:50 syrup:20',
};

/** Сеты = сумма роллов */
const COMBOS = {
  st1: ['rh4', 'rh8', 'rh5', 'rh9'],
  st2: ['rh12', 'rh5', 'rc4', 'rc1'],
  st3: ['rh9', 'rc4', 'rc2', 'rc8', 'rh6'],
  st4: ['rh2', 'rc6', 'rh11', 'rc7', 'rc8', 'rc3', 'rh8', 'rh10'],
};

/** Варианты блюд, меняющие состав: индекс варианта → замена продуктов */
export const VARIANT_SWAPS = {
  sal2: [{}, { salmon: 'shrimp' }],
  mn5:  [{}, { shrimp: 'salmon' }],
};

/**
 * «Размеры», которые на самом деле меняют состав, а не объём
 * (второй размер = «на альтернативном молоке»): без масштабирования, только замена.
 */
export const SIZE_SWAPS = {
  dr15: { milk: 'alt_milk' },
  dr16: { milk: 'alt_milk' },
  dr17: { milk: 'alt_milk' },
};

function parse(str) {
  const out = {};
  for (const tok of str.trim().split(/\s+/)) {
    const [pid, q] = tok.split(':');
    if (!PRODUCT_BY_ID[pid]) throw new Error(`Неизвестный продукт в техкарте: ${pid}`);
    out[pid] = (out[pid] || 0) + Number(q);
  }
  return out;
}

/** RECIPES[dishId] = { productId: qty } */
export const RECIPES = Object.fromEntries(Object.entries(R).map(([id, s]) => [id, parse(s)]));
for (const [id, parts] of Object.entries(COMBOS)) {
  const sum = {};
  for (const p of parts) for (const [pid, q] of Object.entries(RECIPES[p])) sum[pid] = (sum[pid] || 0) + q;
  RECIPES[id] = sum;
}
export const RECIPE_COMBOS = COMBOS;

/**
 * Демо-сценарий стартовых остатков: чтобы на показе сразу было видно
 * стоп-лист, истекающие партии и горячие предложения.
 *  hoursLeft — сколько часов до конца срока; qty — количество.
 */
export const DEMO_SCENARIO = {
  // Креветок почти нет → блюда, где нужно > 40 г, уходят в стоп
  shrimp:     [{ qty: 40, hoursLeft: 50, supplier: 'ООО «Морепродукт»' }, { qty: 600, hoursLeft: -6, supplier: 'ООО «Морепродукт»' }],
  // Дор блю закончился
  dorblu:     [],
  // Лосось — крупная партия истекает через 14 ч → горячие предложения (роллы, Филадельфия)
  salmon:     [{ qty: 2200, hoursLeft: 14, supplier: 'ООО «Норд Фиш»' }, { qty: 900, hoursLeft: 66, supplier: 'ООО «Норд Фиш»' }],
  // Моцарелла — истекает через ~30 ч → пицца в горячих
  mozzarella: [{ qty: 4200, hoursLeft: 30, supplier: 'Сыроварня «Луговая»' }, { qty: 2000, hoursLeft: 200, supplier: 'Сыроварня «Луговая»' }],
  // Молоко — через 20 ч
  milk:       [{ qty: 7000, hoursLeft: 20, supplier: 'АО «Молочный край»' }, { qty: 3000, hoursLeft: 110, supplier: 'АО «Молочный край»' }],
  // Салат — одна партия уже просрочена (покажет автосписание)
  lettuce:    [{ qty: 800, hoursLeft: -3, supplier: 'ИП Гринёв' }, { qty: 1200, hoursLeft: 60, supplier: 'ИП Гринёв' }],
  // Ягоды — скоро истекают
  berries:    [{ qty: 1400, hoursLeft: 9, supplier: 'ИП Гринёв' }],
  // Фарш — мало, но достаточно (прогноз стопа в течение дня)
  minced_meat:[{ qty: 900, hoursLeft: 22, supplier: 'Мясокомбинат «Юг»' }],
};

export const SUPPLIERS = [
  'Мясокомбинат «Юг»', 'ООО «Норд Фиш»', 'ООО «Морепродукт»', 'Сыроварня «Луговая»',
  'АО «Молочный край»', 'ИП Гринёв', 'ООО «Пекарь»', 'ООО «Оптовый двор»', 'ООО «Кофе-Трейд»',
];
