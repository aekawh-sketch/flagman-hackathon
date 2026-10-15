// ═══════════════════════════════════════════════════════════════
//  Выгрузка справочников и демо-данных для бэкенда в JSON.
//  Запуск (Node 18+):   node frontend/tools/export-seed.mjs
//  Результат:           backend-seed/*.json (рядом с папкой frontend)
// ═══════════════════════════════════════════════════════════════
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, '..', 'shared', 'js');
const imp = p => import(pathToFileURL(join(shared, p)).href);

const { PRODUCTS, PRODUCT_GROUPS, RECIPES, RECIPE_COMBOS, VARIANT_SWAPS, SIZE_SWAPS, SUPPLIERS, DEMO_SCENARIO } = await imp('mock/seed.js');
const { CATEGORIES, MENU, PHOTOS } = await imp('menu-catalog.js');
const { CONFIG } = await imp('config.js').catch(() => ({ CONFIG: null }));
const E = await imp('mock/engine.js');

const out = join(here, '..', '..', 'backend-seed');
mkdirSync(out, { recursive: true });
const save = (name, data) => {
  writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('✓', name);
};

save('products.json', { groups: PRODUCT_GROUPS, items: PRODUCTS });
save('recipes.json', {
  _comment: 'RECIPES[dishId] = { productId: qty } на 1 порцию базового размера. Количества ПРИМЕРНЫЕ — сверить с ТТК кухни.',
  recipes: RECIPES,
  combos: RECIPE_COMBOS,
  variant_swaps: VARIANT_SWAPS,
  size_swaps: SIZE_SWAPS,
  size_factor_rule: 'для size=1 количество × price2/price, кроме блюд из size_swaps (там только замена продуктов)',
});
save('menu.json', {
  categories: CATEGORIES,
  items: Object.entries(MENU).flatMap(([cat, items]) => items.map(i => ({ ...i, cat }))),
  photos: PHOTOS,
});
save('suppliers.json', SUPPLIERS);
save('demo-scenario.json', { _comment: 'Особые стартовые партии: hoursLeft — часов до конца срока на момент старта', scenario: DEMO_SCENARIO });

// Стартовые партии/поставки для каждой точки — ровно то, что видит демо-режим
for (const loc of ['kush', 'kan']) {
  const now = Date.now();
  const st = E.createState(loc, now);
  save(`demo-stock-${loc}.json`, {
    _comment: 'Сгенерировано относительно момента выгрузки. При импорте сдвиньте даты на (сейчас − generated_at).',
    generated_at: new Date(now).toISOString(),
    supplies: st.supplies,
    batches: st.batches,
  });
}
if (CONFIG) save('locations.json', CONFIG.LOCATIONS);
console.log(`\nГотово: ${out}`);
