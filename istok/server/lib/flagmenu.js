'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Меню точки другого ресторана — прямо из Флагмана. Витрины (фото,
//  описания) у такого ресторана в панели ИСТОК нет: позиция кассы — вариант
//  блюда склада (id, название, размер, цена). Тот же формат, что у меню ИСТОК
//  (catalog.js), поэтому касса и списание работают с ним без изменений.
//  place.fm — склад от имени вошедшего сотрудника (его сессия, его роль).
// ═══════════════════════════════════════════════════════════════════

/** Цены во Флагмане — в копейках; в заказах панели — целые рубли. */
const rub = kop => Math.round(Number(kop || 0) / 100);
const byId = menu => Object.fromEntries(menu.map(v => [v.variantId, v]));

/** Порции позиции (null — склад её не считает); формат — как у позиции ИСТОК с одним размером. */
function stockOf(v) {
  if (!v?.tracked) return null;
  const n = v.inStop ? 0 : v.portions;
  return { portions: n, variants: [n] };
}

async function hotById(place) {
  try {
    const r = await place.fm.hotOffers(place.loc);
    const out = {};
    for (const o of r.offers || []) out[o.variantId] ||= o;
    return out;
  } catch {
    return {};   // горячие предложения — подсказка, без них касса работает
  }
}

async function payload(place, { staff = false } = {}) {
  const [menu, hot] = await Promise.all([place.fm.menu(place.loc), hotById(place)]);
  const cats = new Map();   // категория склада → id раздела меню
  const items = menu.map(v => {
    const cat = v.category || 'Меню';
    if (!cats.has(cat)) cats.set(cat, `c${cats.size + 1}`);
    const o = hot[v.variantId];
    return {
      id: v.variantId, name: v.name, price: rub(v.priceKop), weight: v.label || '', desc: '', cat: cats.get(cat),
      available: !v.inStop,
      stop_reason: !v.inStop ? null : v.limitingProductName ? `Не хватает: ${v.limitingProductName.toLowerCase()}` : 'Нет в наличии',
      portions_left: !v.inStop && v.low ? v.portions : null,
      hot: o ? {
        priority: Math.max(10, 100 - (o.rank - 1) * 15),
        level: o.rank <= 2 ? 'high' : o.rank <= 5 ? 'medium' : 'low',
        reason_public: 'Выбор шефа на сегодня',
        ...(staff ? { reason: o.explanation, saves_rub: rub(o.lossKop) } : {}),
      } : null,
      ...(staff ? { stock: stockOf(v) } : {}),
    };
  });
  return { categories: [...cats].map(([name, id]) => ({ id, name })), items, updated_at: new Date().toISOString(), source: 'flagman' };
}

/** Позиции корзины: цена и название — со склада, а не из браузера (защита от подмены цены). */
async function normalize(place, items) {
  if (!Array.isArray(items) || !items.length) return { error: 'Корзина пуста' };
  if (items.length > 50) return { error: 'Слишком много позиций в заказе' };
  const menu = byId(await place.fm.menu(place.loc));
  const out = [];
  for (const i of items) {
    const v = menu[String(i?.id || '')];
    if (!v) return { error: 'В заказе есть блюдо, которого нет в меню' };
    const qty = parseInt(i.qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 99) return { error: 'Некорректное количество товара' };
    out.push({ id: v.variantId, name: v.name, price: rub(v.priceKop), qty, size: 0, variant: 0 });
  }
  return { items: out };
}

/** Строки для склада: позиция и есть вариант Флагмана, одинаковые складываем. */
async function stockLines(place, items) {
  const menu = byId(await place.fm.menu(place.loc));
  const lines = items.map(i => ({ ...i, variantId: menu[i.id] ? i.id : null }));
  const agg = {};
  for (const l of lines) if (l.variantId) agg[l.variantId] = (agg[l.variantId] || 0) + l.qty;
  return { byDish: menu, lines, stock: Object.entries(agg).map(([variantId, qty]) => ({ variantId, qty })) };
}

/** Сколько ещё можно пробить каждой позиции после корзины кассы. */
async function left(place, lines) {
  const menu = byId(await place.fm.menu(place.loc));
  const cart = [];
  for (const l of lines || []) {
    const qty = Math.min(100, Math.max(0, Math.floor(Number(l.qty) || 0)));
    if (menu[l.id] && qty) cart.push({ variantId: l.id, qty });
  }
  const out = {};
  for (const v of await place.fm.menuLeft(place.loc, cart.slice(0, 100))) {
    const s = stockOf(v);
    if (s) out[v.variantId] = s;
  }
  return out;
}

/** Отказ склада (409) → формат панели: что не собрать, «максимум N», чего не хватает, похожие блюда. */
function refusal(_place, r, lines) {
  const maxByVariant = Object.fromEntries((r.maxima || []).map(m => [m.variantId, m.max]));
  const missing = (r.shortages || []).map(s => ({ product_id: s.productId, name: s.productName, need: s.needText, available: s.availableText }));
  const unavailable = lines.filter(l => l.variantId in maxByVariant)
    .map(l => ({ id: l.id, name: l.name, size: 0, variant: 0, qty: l.qty, max_qty: maxByVariant[l.variantId], missing }));
  return {
    ok: false,
    code: 'OUT_OF_STOCK',
    error: r.message || 'Недостаточно продуктов',
    unavailable: unavailable.length ? unavailable
      : lines.map(l => ({ id: l.id, name: l.name, size: 0, variant: 0, qty: l.qty, max_qty: 0, missing })),
    alternatives: (r.alternatives || []).map(a => ({ id: a.variantId, size: 0, variant: 0, name: a.name, price: rub(a.priceKop),
      portions: a.portions, hot: a.hot, photo: null })),
  };
}

/** Блюдо для списания по техкарте: { variantId } или { error }. */
async function variantFor(place, b) {
  const v = byId(await place.fm.menu(place.loc))[String(b.itemId || '')];
  return v ? { variantId: v.variantId } : { error: 'Выберите блюдо или напиток из меню' };
}

module.exports = { payload, normalize, stockLines, left, refusal, variantFor };
