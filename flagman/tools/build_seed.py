#!/usr/bin/env python3
"""
Собирает демо-каталог (формат импорта каталога, ТЗ п. 48) из меню пилотного ресторана.

  python3 tools/build_seed.py menu.json backend/src/main/resources/seed/catalog.json

menu.json — объект MENU с сайта ресторана (id, name, price, price2, sizes, variantOpts, desc).
Техкарты — правдоподобные черновики по описаниям блюд (для демо); для реальной работы их
заменяют настоящими техкартами владельца.
"""
import json
import math
import re
import sys

# ─── Продукты ───────────────────────────────────────────────────────────────
# id, название, единица, категория, цена (₽ за кг / л / шт), срок хранения (ч),
# доп.: pack — упаковка, open — срок после вскрытия (ч), loss — потери %, alert — окно «скоро» (ч)
P = []


def prod(pid, name, unit, cat, price, shelf, pack=None, open_h=None, loss=0, alert=None, lead=24):
    P.append(dict(id=pid, name=name, unit=unit, category=cat, price=price, shelfLifeHours=shelf,
                  packSize=pack, afterOpenHours=open_h, lossPct=loss, alertBeforeHours=alert,
                  leadTimeHours=lead))


# Хлеб, тесто, крупы
prod("bun", "Булочка для бургера", "PCS", "Хлеб и тесто", 25, 72)
prod("lavash", "Лаваш", "PCS", "Хлеб и тесто", 30, 120)
prod("pita", "Лепёшка для гироса", "PCS", "Хлеб и тесто", 28, 120)
prod("flour", "Мука", "G", "Бакалея", 55, 24 * 180, lead=48)
prod("rice", "Рис для суши (сухой)", "G", "Бакалея", 160, 24 * 365, lead=48)
prod("spaghetti", "Спагетти", "G", "Бакалея", 200, 24 * 365, lead=48)
prod("fettuccine", "Фетучини", "G", "Бакалея", 260, 24 * 365, lead=48)
prod("udon", "Лапша удон", "G", "Бакалея", 400, 24 * 180, lead=48)
prod("funchoza", "Фунчоза", "G", "Бакалея", 450, 24 * 365, lead=48)
prod("tapioca_dry", "Тапиока (шарики, сухая)", "G", "Бакалея", 600, 24 * 365, lead=72)
prod("nori", "Нори", "PCS", "Бакалея", 9, 24 * 180, lead=72)
prod("croutons", "Крутоны", "G", "Бакалея", 600, 24 * 60)
prod("sugar", "Сахар", "G", "Бакалея", 80, 24 * 365, lead=48)
prod("sesame", "Кунжут", "G", "Бакалея", 500, 24 * 180, lead=48)
prod("spices", "Специи", "G", "Бакалея", 1500, 24 * 365, lead=72)
prod("yeast", "Дрожжи", "G", "Бакалея", 900, 24 * 60, lead=48)
prod("olive_oil", "Масло оливковое", "ML", "Бакалея", 900, 24 * 365, pack=1000, open_h=24 * 60, lead=48)
prod("rice_vinegar", "Рисовый уксус", "ML", "Бакалея", 300, 24 * 365, pack=500, open_h=24 * 90, lead=48)
prod("olives", "Маслины", "G", "Бакалея", 700, 24 * 365, lead=48)
prod("pineapple", "Ананас консервированный", "G", "Бакалея", 350, 24 * 365, lead=48)
prod("corn", "Кукуруза консервированная", "G", "Бакалея", 300, 24 * 365, lead=48)
# Мясо, птица
prod("patty_pork", "Котлета свиная", "PCS", "Мясо", 70, 72, alert=18)
prod("patty_chicken", "Котлета куриная", "PCS", "Мясо", 60, 48, alert=12)
prod("patty_beef", "Котлета говяжья", "PCS", "Мясо", 95, 72, alert=18)
prod("patty_mixed", "Котлета свино-говяжья", "PCS", "Мясо", 80, 72, alert=18)
prod("patty_cheese", "Котлета сырная", "PCS", "Мясо", 75, 96)
prod("schnitzel", "Шницель куриный", "PCS", "Мясо", 70, 48, alert=12)
prod("bacon", "Бекон", "G", "Мясо", 750, 24 * 10)
prod("chicken", "Куриное филе", "G", "Мясо", 420, 48, alert=12)
prod("chicken_smoked", "Курица копчёная", "G", "Мясо", 650, 24 * 7)
prod("pork", "Свинина", "G", "Мясо", 450, 72, alert=18)
prod("pork_braised", "Томлёная свинина", "G", "Мясо", 650, 72)
prod("ribs", "Свиные рёбра", "G", "Мясо", 480, 72, alert=18)
prod("mince", "Фарш свино-говяжий", "G", "Мясо", 480, 36, alert=10)
prod("ham", "Ветчина", "G", "Мясо", 600, 24 * 10)
prod("pepperoni", "Пепперони", "G", "Мясо", 900, 24 * 30)
prod("carbonate", "Карбонат", "G", "Мясо", 800, 24 * 10)
prod("meat_assorted", "Мясное ассорти для солянки", "G", "Мясо", 700, 72)
prod("egg", "Яйцо", "PCS", "Молочное и яйца", 12, 24 * 20)
# Рыба и морепродукты
prod("salmon", "Лосось", "G", "Рыба", 1800, 72, alert=12)
prod("shrimp", "Креветка", "G", "Рыба", 1100, 48, alert=12)
prod("seafood_mix", "Морской коктейль", "G", "Рыба", 650, 48, alert=12)
prod("mussels", "Мясо мидий", "G", "Рыба", 700, 48, alert=12)
prod("crab_sticks", "Краб (имитация)", "G", "Рыба", 400, 24 * 7)
prod("masago", "Икра масаго", "G", "Рыба", 2500, 24 * 30, pack=500, open_h=24 * 5)
# Сыры и молочное
prod("gouda", "Сыр гауда", "G", "Молочное и яйца", 800, 24 * 30, pack=1000, open_h=24 * 7)
prod("cheddar", "Сыр чеддер", "G", "Молочное и яйца", 900, 24 * 30, pack=1000, open_h=24 * 7)
prod("mozzarella", "Сыр моцарелла", "G", "Молочное и яйца", 750, 24 * 20, pack=1000, open_h=24 * 5)
prod("parmesan", "Сыр пармезан", "G", "Молочное и яйца", 1600, 24 * 60)
prod("dorblu", "Сыр дорблю", "G", "Молочное и яйца", 2200, 24 * 30)
prod("cream_cheese", "Сыр сливочный", "G", "Молочное и яйца", 900, 24 * 30, pack=1000, open_h=24 * 5)
prod("feta", "Брынза", "G", "Молочное и яйца", 700, 24 * 14)
prod("milk", "Молоко", "ML", "Молочное и яйца", 90, 24 * 7, pack=1000, open_h=48)
prod("cream", "Сливки 33%", "ML", "Молочное и яйца", 450, 24 * 10, pack=1000, open_h=72)
prod("alt_milk", "Молоко растительное", "ML", "Молочное и яйца", 300, 24 * 60, pack=1000, open_h=24 * 5)
prod("sour_cream", "Сметана", "G", "Молочное и яйца", 300, 24 * 10, pack=500, open_h=72)
prod("ice_cream", "Мороженое пломбир", "G", "Молочное и яйца", 500, 24 * 90)
prod("condensed_milk", "Сгущённое молоко", "G", "Молочное и яйца", 400, 24 * 180)
prod("tvorog", "Творог", "G", "Молочное и яйца", 450, 24 * 5)
# Овощи, зелень, фрукты
prod("tomato", "Томаты", "G", "Овощи и зелень", 250, 24 * 5, loss=5)
prod("cucumber", "Огурцы свежие", "G", "Овощи и зелень", 200, 24 * 6, loss=5)
prod("pickles", "Огурцы солёные", "G", "Овощи и зелень", 300, 24 * 60)
prod("onion", "Лук репчатый", "G", "Овощи и зелень", 60, 24 * 30, loss=15)
prod("red_onion", "Лук красный", "G", "Овощи и зелень", 90, 24 * 30, loss=15)
prod("green_onion", "Лук зелёный", "G", "Овощи и зелень", 600, 48)
prod("lettuce", "Лист салата", "G", "Овощи и зелень", 600, 72, loss=10)
prod("cabbage", "Капуста пекинская", "G", "Овощи и зелень", 120, 24 * 7, loss=10)
prod("carrot_korean", "Морковь по-корейски", "G", "Овощи и зелень", 300, 24 * 5)
prod("carrot", "Морковь", "G", "Овощи и зелень", 60, 24 * 20, loss=20)
prod("bell_pepper", "Перец болгарский", "G", "Овощи и зелень", 350, 24 * 7, loss=15)
prod("jalapeno", "Перец халапеньо", "G", "Овощи и зелень", 900, 24 * 90)
prod("mushrooms", "Шампиньоны", "G", "Овощи и зелень", 350, 24 * 4, loss=5)
prod("zucchini", "Кабачок", "G", "Овощи и зелень", 150, 24 * 7, loss=10)
prod("herbs", "Зелень (петрушка, укроп)", "G", "Овощи и зелень", 800, 48, loss=15)
prod("cilantro", "Кинза", "G", "Овощи и зелень", 900, 48, loss=15)
prod("basil", "Базилик", "G", "Овощи и зелень", 1500, 48, loss=10)
prod("garlic", "Чеснок", "G", "Овощи и зелень", 300, 24 * 60, loss=15)
prod("lemon", "Лимон", "G", "Овощи и зелень", 250, 24 * 14)
prod("orange", "Апельсины", "G", "Овощи и зелень", 180, 24 * 14)
prod("potato", "Картофель", "G", "Овощи и зелень", 50, 24 * 30, loss=25)
prod("banana", "Банан", "G", "Овощи и зелень", 150, 24 * 5, loss=30)
prod("strawberry", "Клубника", "G", "Овощи и зелень", 600, 48)
prod("raspberry", "Малина (замороженная)", "G", "Овощи и зелень", 800, 24 * 180)
prod("currant_jam", "Конфитюр смородиновый", "G", "Бакалея", 500, 24 * 180)
# Заморозка
prod("fries", "Картофель фри (заморозка)", "G", "Заморозка", 220, 24 * 180, lead=48)
prod("wedges", "Картофель дольки (заморозка)", "G", "Заморозка", 250, 24 * 180, lead=48)
prod("onion_rings", "Луковые кольца (заморозка)", "G", "Заморозка", 450, 24 * 180, lead=48)
prod("nuggets", "Наггетсы (заморозка)", "G", "Заморозка", 550, 24 * 180, lead=48)
prod("wings", "Куриные крылья", "G", "Мясо", 380, 48, alert=12)
prod("cheese_sticks", "Сырные палочки (заморозка)", "G", "Заморозка", 900, 24 * 180, lead=48)
prod("syrniki", "Сырники (полуфабрикат)", "PCS", "Заморозка", 35, 24 * 60, lead=48)
# Соусы покупные
prod("mayo", "Майонез", "G", "Соусы", 220, 24 * 90, pack=1000, open_h=24 * 14)
prod("ketchup", "Кетчуп", "G", "Соусы", 200, 24 * 180, pack=1000, open_h=24 * 30)
prod("bbq", "Соус барбекю", "G", "Соусы", 400, 24 * 180, pack=1000, open_h=24 * 30)
prod("sweet_chili", "Соус сладкий чили", "G", "Соусы", 450, 24 * 180, pack=1000, open_h=24 * 30)
prod("teriyaki", "Соус терияки", "G", "Соусы", 500, 24 * 180, pack=1000, open_h=24 * 30)
prod("unagi", "Соус унаги", "G", "Соусы", 600, 24 * 180, pack=1000, open_h=24 * 30)
prod("soy", "Соевый соус", "ML", "Соусы", 250, 24 * 365, pack=1000, open_h=24 * 60)
prod("sriracha", "Соус шрирача", "G", "Соусы", 700, 24 * 180, pack=500, open_h=24 * 30)
prod("tartar", "Соус тар-тар", "G", "Соусы", 450, 24 * 90, pack=1000, open_h=24 * 14)
prod("mustard", "Соус горчичный", "G", "Соусы", 400, 24 * 180, pack=1000, open_h=24 * 30)
prod("islands", "Соус «1000 островов»", "G", "Соусы", 450, 24 * 90, pack=1000, open_h=24 * 14)
prod("oyster", "Соус устричный", "G", "Соусы", 600, 24 * 180, pack=500, open_h=24 * 30)
prod("pesto", "Соус песто", "G", "Соусы", 1800, 24 * 60, pack=500, open_h=24 * 7)
prod("tomato_sauce", "Соус томатный", "G", "Соусы", 250, 24 * 180, pack=1000, open_h=24 * 7)
prod("spicy_sauce", "Соус «Спайс»", "G", "Соусы", 500, 24 * 90, pack=1000, open_h=24 * 14)
prod("sesame_sauce", "Кунжутный соус", "G", "Соусы", 700, 24 * 90, pack=500, open_h=24 * 14)
prod("honey_mustard", "Соус медово-горчичный", "G", "Соусы", 500, 24 * 90, pack=1000, open_h=24 * 14)
prod("tomyam_paste", "Паста том ям", "G", "Соусы", 1500, 24 * 180)
prod("coconut_milk", "Кокосовое молоко", "ML", "Бакалея", 400, 24 * 365, pack=400, open_h=72)
# Напитки
prod("coffee", "Кофе в зёрнах", "G", "Напитки", 2000, 24 * 180, lead=48)
prod("tea", "Чай листовой", "G", "Напитки", 1500, 24 * 365, lead=48)
prod("matcha", "Матча", "G", "Напитки", 6000, 24 * 180, lead=72)
prod("cocoa", "Какао", "G", "Напитки", 900, 24 * 365, lead=48)
prod("syrup", "Сироп (ассорти)", "ML", "Напитки", 600, 24 * 365, pack=1000, open_h=24 * 30)
prod("puree", "Фруктовое пюре (ассорти)", "G", "Напитки", 700, 24 * 120, pack=1000, open_h=24 * 5)
prod("juice_balls", "Джус-болы", "G", "Напитки", 900, 24 * 180, pack=1000, open_h=24 * 14)
prod("marshmallow", "Маршмеллоу", "G", "Напитки", 800, 24 * 180)
prod("coconut_flakes", "Кокосовая стружка", "G", "Напитки", 700, 24 * 180)
prod("popcorn", "Попкорн", "G", "Напитки", 600, 24 * 90)
prod("tonic", "Тоник", "ML", "Напитки", 200, 24 * 365, pack=1000, open_h=48)
prod("lemonade_base", "Газированная вода", "ML", "Напитки", 60, 24 * 365, pack=1000, open_h=48)
prod("ice", "Лёд", "G", "Напитки", 20, 24 * 365)
prod("cherry", "Вишня (замороженная)", "G", "Напитки", 500, 24 * 180)
prod("anchan", "Чай анчан", "G", "Напитки", 3000, 24 * 365, lead=72)

# ─── Заготовки (полуфабрикаты, ТЗ 5.4) ─────────────────────────────────────
SEMI = []


def semi(pid, name, price_hint, shelf, yield_qty, lines, alert=None):
    P.append(dict(id=pid, name=name, unit="G", category="Заготовки", price=price_hint, shelfLifeHours=shelf,
                  kind="SEMI", alertBeforeHours=alert, leadTimeHours=None))
    SEMI.append(dict(productId=pid, yieldQty=yield_qty, lines=[dict(productId=a, net=b) for a, b in lines]))


semi("rice_sushi", "Рис для роллов", 0, 6, 1000, [("rice", 420), ("rice_vinegar", 40), ("sugar", 20)])
semi("tapioca_cooked", "Тапиока варёная", 0, 4, 1000, [("tapioca_dry", 350), ("sugar", 120)])
semi("dough_pizza", "Тесто для пиццы", 0, 48, 1000, [("flour", 600), ("yeast", 8), ("olive_oil", 30), ("sugar", 10)])
semi("sauce_signature", "Соус «Фирменный»", 0, 72, 1000, [("mayo", 600), ("ketchup", 200), ("pickles", 120),
                                                            ("garlic", 20), ("spices", 5)])
semi("sauce_caesar", "Соус «Цезарь»", 0, 72, 1000, [("mayo", 650), ("parmesan", 120), ("garlic", 30), ("mustard", 40)])
semi("sauce_cheese", "Сырный соус", 0, 48, 1000, [("cream", 600), ("cheddar", 350), ("gouda", 100)])
semi("sauce_garlic", "Чесночный соус", 0, 72, 1000, [("mayo", 850), ("garlic", 60), ("herbs", 20)])
semi("bolognese", "Соус «Болоньезе»", 0, 48, 1000, [("mince", 500), ("tomato_sauce", 400), ("onion", 120),
                                                     ("garlic", 15), ("spices", 5)])
semi("crab_mix", "Крабовый замес", 0, 24, 1000, [("crab_sticks", 620), ("mayo", 300), ("masago", 60)])

IDS = {p["id"] for p in P}

# ─── Распознавание ингредиентов по описанию ────────────────────────────────
# (шаблон, продукт, роль) — роль задаёт граммовку в зависимости от категории блюда.
RULES = [
    (r"двойн|2 котлет", "patty_pork", "patty2"),
    (r"тройн|3 свин", "patty_pork", "patty3"),
    (r"котлета говяжья", "patty_beef", "patty"),
    (r"котлета св\.-говяж|св\.-говяж", "patty_mixed", "patty"),
    (r"котлета сырная", "patty_cheese", "patty"),
    (r"куриная котлета|котлета свиная или куриная", "patty_chicken", "patty"),
    (r"котлета свиная|свиная котлета", "patty_pork", "patty"),
    (r"шницель", "schnitzel", "patty"),
    (r"томлён", "pork_braised", "meat"),
    (r"рёберн|рёбра|свиные рёбра|св\. рёбра", "ribs", "meat"),
    (r"фарш", "mince", "meat"),
    (r"бекон", "bacon", "bacon"),
    (r"копчён", "chicken_smoked", "meat"),
    (r"цыпл|курица|куриное филе|курин", "chicken", "meat"),
    (r"свинина", "pork", "meat"),
    (r"ветчина", "ham", "meat"),
    (r"пепперони", "pepperoni", "meat"),
    (r"карбонат", "carbonate", "meat"),
    (r"лосос", "salmon", "fish"),
    (r"крабовый замес", "crab_mix", "crabmix"),
    (r"краб", "crab_sticks", "fish"),
    (r"мидий", "mussels", "fish"),
    (r"креветк", "shrimp", "fish"),
    (r"морской коктейль|морепродукт", "seafood_mix", "fish"),
    (r"масаго", "masago", "masago"),
    (r"сливочный сыр", "cream_cheese", "creamcheese"),
    (r"сырный соус", "sauce_cheese", "sauce"),
    (r"смесь сыров", "mozzarella", "cheese_main"),
    (r"моцарелла", "mozzarella", "cheese_main"),
    (r"пармезан", "parmesan", "cheese_minor"),
    (r"дор-?блю|дорблю", "dorblu", "cheese_minor"),
    (r"чеддер", "cheddar", "cheese_minor"),
    (r"гауда|сыр,|^сыр$", "gouda", "cheese_slice"),
    (r"брынза", "feta", "cheese_main"),
    (r"смородин", "currant_jam", "sauce"),
    (r"луковые кольца", "onion_rings", "rings"),
    (r"картофель-фри|картофель фри", "fries", "side"),
    (r"картофельные дольки|картофель по-домашнему", "wedges", "side"),
    (r"томатный соус", "tomato_sauce", "sauce_big"),
    (r"томат|помидор", "tomato", "veg"),
    (r"огурцы сол|огурец сол|солёные огурцы|огурцы соленые|огурцы сол\.", "pickles", "veg_small"),
    (r"огур", "cucumber", "veg"),
    (r"лук красный|красный лук|красного лука", "red_onion", "veg_small"),
    (r"лук жареный", "onion", "veg_small"),
    (r"зелёный лук", "green_onion", "herb"),
    (r"лук", "onion", "veg_small"),
    (r"лист салата|салат", "lettuce", "leaf"),
    (r"капуст", "cabbage", "veg"),
    (r"морковь по-корейски|морковь", "carrot_korean", "veg"),
    (r"болгарский перец|перец болгарский", "bell_pepper", "veg"),
    (r"халапеньо", "jalapeno", "veg_small"),
    (r"шампиньон", "mushrooms", "veg"),
    (r"кабачок", "zucchini", "veg"),
    (r"кукуруз", "corn", "veg"),
    (r"маслин", "olives", "veg_small"),
    (r"ананас", "pineapple", "veg"),
    (r"базилик", "basil", "herb"),
    (r"кинза", "cilantro", "herb"),
    (r"зелень|прованские травы", "herbs", "herb"),
    (r"кунжутный соус", "sesame_sauce", "sauce"),
    (r"кунжут", "sesame", "herb"),
    (r"нори|водоросли", "nori", "nori"),
    (r"крутон", "croutons", "croutons"),
    (r"болоньезе", "bolognese", "sauce_big"),
    (r"«цезарь»|соус цезарь|соус «цезарь»", "sauce_caesar", "sauce"),
    (r"фирменн", "sauce_signature", "sauce"),
    (r"чесночн", "sauce_garlic", "sauce"),
    (r"сливочный соус", "sauce_cheese", "sauce"),
    (r"барбекю|«гриль»", "bbq", "sauce"),
    (r"сладкий чили|«сладкий чили»", "sweet_chili", "sauce"),
    (r"тар-тар", "tartar", "sauce"),
    (r"1000 островов", "islands", "sauce"),
    (r"горчичн", "mustard", "sauce"),
    (r"шрирача", "sriracha", "sauce_small"),
    (r"спайс", "spicy_sauce", "sauce_small"),
    (r"«дабл-бургер»", "sauce_signature", "sauce"),
    (r"унаги", "unagi", "sauce_small"),
    (r"терияки", "teriyaki", "sauce_small"),
    (r"устричн", "oyster", "sauce_small"),
    (r"соевый", "soy", "sauce_small"),
    (r"песто", "pesto", "sauce_small"),
    (r"кетчуп", "ketchup", "sauce"),
    (r"сливки", "cream", "cream"),
    (r"яйцо", "egg", "egg"),
    (r"рис", "rice_sushi", "rice"),
    (r"спагетти", "spaghetti", "pasta"),
    (r"фетучини", "fettuccine", "pasta"),
    (r"масло", "olive_oil", "sauce_small"),
    (r"сметана", "sour_cream", "sauce"),
    (r"специи", "spices", "spice"),
]

# Граммовки нетто по категории блюда и роли.
G = {
    "burgers": dict(patty=1, patty2=2, patty3=3, bacon=30, meat=70, fish=60, cheese_slice=20, cheese_minor=20,
                    cheese_main=30, creamcheese=20, sauce=25, sauce_small=15, sauce_big=40, veg=30, veg_small=15,
                    leaf=15, herb=3, rings=40, side=40, egg=1),
    "notburgers": dict(meat=110, bacon=30, veg=35, veg_small=15, leaf=15, sauce=35, sauce_small=15, side=60,
                       cheese_slice=20, herb=3),
    "salads": dict(meat=80, fish=70, veg=55, veg_small=15, leaf=50, cheese_minor=20, cheese_main=35, sauce=30,
                   sauce_small=10, croutons=15, herb=5, side=60, spice=2),
    "pizza": dict(meat=70, bacon=40, fish=70, veg=40, veg_small=15, leaf=10, herb=3, cheese_main=150,
                  cheese_minor=30, cheese_slice=30, sauce=50, sauce_small=20, sauce_big=70, creamcheese=40),
    "rolls_cold": dict(fish=40, meat=40, veg=20, veg_small=10, creamcheese=35, masago=10, crabmix=40, rice=120,
                       sauce=15, sauce_small=10, nori=1, herb=3, leaf=10),
    "rolls_hot": dict(fish=40, meat=40, bacon=20, veg=20, veg_small=10, creamcheese=35, masago=10, crabmix=40,
                      rice=130, sauce=20, sauce_small=10, nori=1, herb=3, leaf=10, cheese_main=25),
    "mains": dict(meat=120, fish=110, bacon=40, veg=35, veg_small=15, leaf=15, herb=3, cheese_minor=25,
                  sauce=35, sauce_small=15, sauce_big=90, cream=80, egg=1, rice=180, pasta=100, masago=10,
                  nori=1, side=150, patty=1),
}
RECIPE_EXTRA = {
    "burgers": [("bun", 1)],
    "pizza": [("dough_pizza", 280), ("tomato_sauce", 40)],
    "rolls_cold": [("nori", 1)],
    "rolls_hot": [("nori", 1), ("mozzarella", 20)],
}


def lines_from_desc(desc, cat):
    grams = G[cat]
    parts = [p.strip().lower() for p in re.split(r",|/", desc) if p.strip()]
    out = {}
    for part in parts:
        for pattern, pid, role in RULES:
            if re.search(pattern, part):
                if role in grams:
                    out[pid] = out.get(pid, 0) + grams[role]
                break
    for pid, q in RECIPE_EXTRA.get(cat, []):
        out.setdefault(pid, q)
    return out


def scaled(lines, k):
    # Штучное (лаваш, булочка, нори, яйцо) при смене размера не меняется.
    return {pid: q if q <= 3 else max(1, math.ceil(q * k)) for pid, q in lines.items()}


# ─── Явные техкарты: напитки, супы, закуски, горячее ────────────────────────
EXPLICIT = {
    # Закуски
    "sn1": {"fries": 140, "spices": 2},
    "sn2": {"wedges": 140, "spices": 2},
    "sn3": {"wedges": 200, "mince": 80, "bbq": 40},
    "sn4": {"cheese_sticks": 150, "currant_jam": 30},
    "sn5": {"nuggets": 150, "ketchup": 30},
    "sn6": {"wings": 220, "bbq": 30},
    "sn7": {"onion_rings": 170, "sauce_garlic": 30},
    # Супы (порция 340 г; 600 г — ×1,75)
    "sp1": {"shrimp": 60, "mushrooms": 40, "coconut_milk": 120, "tomyam_paste": 20, "tomato": 30, "cilantro": 3,
            "lemon": 10},
    "sp2": {"meat_assorted": 90, "pickles": 40, "olives": 15, "tomato_sauce": 30, "lemon": 10, "sour_cream": 20,
            "onion": 20},
    "sp3": {"mushrooms": 150, "cream": 100, "onion": 30, "croutons": 10},
    # Горячее
    "mn1": {"spaghetti": 100, "bacon": 50, "parmesan": 25, "cream": 80, "egg": 1},
    "mn2": {"spaghetti": 100, "seafood_mix": 110, "parmesan": 25, "cream": 80},
    "mn3": {"fettuccine": 100, "bolognese": 120, "parmesan": 25},
    "mn4": {"rice_sushi": 200, "seafood_mix": 110, "egg": 1, "zucchini": 30, "bell_pepper": 25, "carrot": 20,
            "onion": 15, "cilantro": 3, "sesame": 3, "soy": 15, "teriyaki": 15, "sriracha": 5},
    "mn6": {"rice_sushi": 180, "chicken": 100, "corn": 30, "tomato": 30, "cucumber": 30, "masago": 10, "nori": 1,
            "sauce_garlic": 25, "teriyaki": 15},
    "mn9": {"ribs": 350, "pickles": 30, "jalapeno": 10, "red_onion": 20, "sweet_chili": 40},
    "mn10": {"patty_mixed": 1, "wedges": 150, "egg": 1, "sauce_caesar": 30, "herbs": 3},
    # Холодные роллы — простые
    "rc10": {"syrniki": 3, "sour_cream": 30, "condensed_milk": 20, "strawberry": 20},
    # Напитки (мл/г на порцию)
    "dr1": {"milk": 220, "coffee": 18, "raspberry": 30, "syrup": 20, "ice": 120},
    "dr2": {"tea": 5, "cream": 40, "puree": 30, "syrup": 15, "ice": 150},
    "dr3": {"milk": 200, "coffee": 18, "cocoa": 15, "tapioca_cooked": 60, "cream_cheese": 20, "popcorn": 5,
            "ice": 100},
    "dr4": {"milk": 220, "cocoa": 20, "banana": 60, "coconut_flakes": 5, "ice": 100},
    "dr5": {"milk": 220, "matcha": 4, "tapioca_cooked": 60, "cream_cheese": 20, "strawberry": 20, "ice": 100},
    "dr6": {"milk": 200, "coffee": 18, "cream": 40, "syrup": 25, "tapioca_cooked": 60, "marshmallow": 10, "ice": 100},
    "dr7": {"lemonade_base": 250, "syrup": 30, "lemon": 15, "ice": 120},
    "dr8": {"tea": 5, "juice_balls": 40, "syrup": 25, "ice": 150},
    "dr9": {"tonic": 200, "puree": 40, "lemon": 15, "ice": 120},
    "dr10": {"lemonade_base": 220, "strawberry": 30, "banana": 30, "anchan": 2, "syrup": 20, "ice": 120},
    "dr11": {"coffee": 9},
    "dr12": {"coffee": 9},
    "dr13": {"coffee": 9, "milk": 150},
    "dr14": {"coffee": 9, "alt_milk": 150},
    "dr15": {"coffee": 18, "milk": 180, "ice": 100},
    "dr16": {"coffee": 18, "milk": 120},
    "dr17": {"coffee": 9, "milk": 250},
    "dr18": {"coffee": 18, "cream": 100, "syrup": 15},
    "dr19": {"milk": 250, "cocoa": 25, "marshmallow": 15},
    "dr20": {"tea": 4},
    "dr21": {"tea": 4, "puree": 40, "anchan": 2, "syrup": 15},
    "dr22": {"tea": 4, "puree": 40, "syrup": 15},
    "dr23": {"tea": 3, "puree": 50, "syrup": 15},
    "dr24": {"puree": 80, "strawberry": 40, "syrup": 20, "ice": 200},
    "dr25": {"milk": 200, "ice_cream": 120, "syrup": 10},
    "dr26": {"milk": 200, "ice_cream": 120, "cocoa": 20},
    "dr27": {"milk": 200, "ice_cream": 120, "raspberry": 40},
    "dr28": {"cherry": 60, "tapioca_cooked": 60, "syrup": 25, "lemonade_base": 200, "ice": 100},
    # Новые напитки сайта ИСТОК: состав — из техкарт сайта, переведённый на продукты склада.
    "dr40": {"tea": 5, "strawberry": 40, "syrup": 15, "ice": 120},
    "dr41": {"tea": 5, "cherry": 40, "tapioca_cooked": 50, "syrup": 20, "milk": 100, "ice": 100},
    "dr42": {"orange": 350},
    "dr43": {"tea": 5, "orange": 120, "lemon": 15, "syrup": 10, "ice": 120},
    "dr44": {"tea": 5, "raspberry": 40, "anchan": 2, "syrup": 15, "ice": 120},
    "dr45": {"coffee": 18, "milk": 200, "cream": 40, "syrup": 10},
    "dr46": {"tea": 5, "milk": 150, "puree": 30, "syrup": 20, "ice": 100},
    "dr47": {"cocoa": 25, "milk": 200, "tapioca_cooked": 50, "ice": 100},
    "dr48": {"coffee": 18, "milk": 150, "ice_cream": 100, "cocoa": 15, "ice": 100},
    "dr49": {"coffee": 18, "milk": 150, "ice_cream": 80, "cream_cheese": 30, "cocoa": 10, "ice": 100},
    "dr50": {"matcha": 4, "milk": 200, "tapioca_cooked": 50, "ice": 100},
    "dr51": {"coffee": 18, "milk": 200, "tapioca_cooked": 50, "syrup": 20, "ice": 100},
}

# Варианты: подпись → функция, меняющая техкарту базового варианта.
SIZE_SCALE = {"Маленькая": 1.0, "Большая": 1.6, "340 г": 1.0, "600 г": 1.75, "40 мл": 1.0, "80 мл": 2.0,
              "200 мл": 1.0, "300 мл": 1.4, "250 мл": 1.0, "800 мл": 3.0}
PIZZA_SCALE = 1.75  # 40 см против 30 см


def variant_lines(item, label, base):
    if label in ("На альт. молоке",):
        out = dict(base)
        if "milk" in out:
            out["alt_milk"] = out.pop("milk")
        return out
    if label in ("Классический",):
        return dict(base)
    if label in ("С лососем", "С креветкой", "С креветками"):
        out = {k: v for k, v in base.items() if k not in ("salmon", "shrimp")}
        out["salmon" if label == "С лососем" else "shrimp"] = base.get("salmon") or base.get("shrimp") or 70
        return out
    if label in ("Фунчоза", "Удон"):
        out = dict(base)
        out["funchoza" if label == "Фунчоза" else "udon"] = 90
        return out
    if label in ("Чёрный", "Зелёный", "Фруктовый"):
        return dict(base)
    if label in SIZE_SCALE:
        return scaled(base, SIZE_SCALE[label])
    return dict(base)


def build(menu):
    cat_names = {"burgers": "Бургеры", "notburgers": "Шаурма и гирос", "snacks": "Закуски", "salads": "Салаты",
                 "soups": "Супы", "pizza": "Пицца", "rolls_cold": "Холодные роллы", "rolls_hot": "Запечённые роллы",
                 "drinks": "Напитки", "sets": "Сеты", "mains": "Горячее"}
    dishes, sets = [], []
    by_name = {}
    sort = 0
    for cat, items in menu.items():
        for it in items:
            sort += 1
            iid, name, desc = it["id"], it["name"], it.get("desc", "")
            if cat == "sets":
                dishes.append(dict(id=iid, name=name, category=cat_names[cat], description=desc, sort=sort,
                                   variants=[dict(id=iid, name=name, label=None, priceKop=it["price"] * 100,
                                                  isSet=True, lines=[])]))
                sets.append(dict(variantId=iid, names=[n.strip() for n in desc.split(",")]))
                continue
            if iid in EXPLICIT:
                base = dict(EXPLICIT[iid])
            elif cat in G:
                base = lines_from_desc(desc, cat)
                if iid == "mn5":
                    base = {"rice_sushi": 180, "shrimp": 80, "corn": 30, "tomato": 30, "cucumber": 30, "masago": 10,
                            "nori": 1, "sauce_garlic": 25, "teriyaki": 15}
                if iid in ("mn7", "mn8"):
                    base.setdefault("chicken" if iid == "mn7" else "seafood_mix", 100)
                if cat == "notburgers" and iid.startswith("nb"):
                    base.setdefault("lavash" if "Шаурма" in name else "pita", 1)
                if cat == "notburgers" and "Гирос" in name:
                    base["fries"] = 60
            else:
                base = {}
            for pid in base:
                assert pid in IDS, (iid, pid)
            variants = []
            labels = it.get("sizes") or it.get("variantOpts")
            prices = [it["price"], it.get("price2") or it["price"]]
            if it.get("pizza"):
                variants.append(dict(id=iid + "-30", label="30 см", name=name + " 30 см", priceKop=prices[0] * 100,
                                     lines=base))
                variants.append(dict(id=iid + "-40", label="40 см", name=name + " 40 см", priceKop=prices[1] * 100,
                                     lines=scaled(base, PIZZA_SCALE)))
            elif labels:
                names = it.get("variantNames") or [name + " " + lab for lab in labels]
                for k, lab in enumerate(labels):
                    price = prices[min(k, 1)] if it.get("price2") else it["price"]
                    variants.append(dict(id=f"{iid}-{k + 1}", label=lab, name=names[k] if k < len(names) else name,
                                         priceKop=price * 100, lines=variant_lines(it, lab, base)))
            else:
                variants.append(dict(id=iid, label=None, name=name, priceKop=it["price"] * 100, lines=base))
            for v in variants:
                v["lines"] = [dict(productId=pid, net=int(q)) for pid, q in v["lines"].items()]
                by_name.setdefault(name.lower(), v["id"])
            dishes.append(dict(id=iid, name=name, category=cat_names[cat], description=desc, sort=sort,
                               variants=variants))
    set_out = []
    for s in sets:
        items = []
        for n in s["names"]:
            key = n.lower()
            vid = by_name.get(key) or by_name.get("ролл " + key)
            assert vid, ("set item not found", n)
            items.append(dict(variantId=vid, qty=1))
        set_out.append(dict(variantId=s["variantId"], items=items))
    return dict(products=P, semi=SEMI, dishes=dishes, sets=set_out)


if __name__ == "__main__":
    menu = json.load(open(sys.argv[1], encoding="utf-8"))
    if isinstance(menu.get("items"), list):
        # Формат сайта ИСТОК (seed/menu.json): плоский список с полем cat → {категория: [блюда]} в том же порядке.
        grouped = {}
        for it in menu["items"]:
            grouped.setdefault(it["cat"], []).append(it)
        menu = grouped
    catalog = build(menu)
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)
    nv = sum(len(d["variants"]) for d in catalog["dishes"])
    empty = [v["id"] for d in catalog["dishes"] for v in d["variants"] if not v.get("isSet") and not v["lines"]]
    print(f"products={len(catalog['products'])} semi={len(catalog['semi'])} dishes={len(catalog['dishes'])} "
          f"variants={nv} sets={len(catalog['sets'])} without_recipe={empty}")
