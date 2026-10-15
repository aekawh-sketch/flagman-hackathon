'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Каталог сайта ИСТОК и сопоставление со складом «Флагман».
//  Витрина (фото, описания, цены) живёт на сайте; что можно продать
//  прямо сейчас — решает склад. id блюд общие; размер/вид блюда на сайте —
//  индекс (size или variant), во Флагмане — отдельный вариант: nb1-1, pz1-40.
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const flagman = require('./flagman');

const MENU_FILE = process.env.SITE_MENU || path.join(__dirname, '..', '..', 'seed', 'menu.json');
const SEED = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
const CATEGORIES = SEED.categories;
const ITEMS = SEED.items;
const BY_ID = Object.fromEntries(ITEMS.map(i => [i.id, i]));

/** Гостю не говорим «скоро испортится» — только нейтральные фразы. */
const PUBLIC_REASONS = ['Выбор шефа на сегодня', 'Особенно хорошо сегодня', 'Свежая партия — пробуйте',
  'Любимое у гостей сегодня', 'Готовим с особым вниманием'];

const variantIndex = (item, line) => (item?.variantOpts ? Number(line.variant) || 0 : Number(line.size) || 0);

/** Цена по каталогу сайта: клиент не может прислать свою (защита от подмены цены). */
function price(item, size) {
  return Number(size) === 1 && item.price2 ? item.price2 : item.price;
}

/** Варианты Флагмана по блюду в порядке размеров сайта: [nb1-1, nb1-2], [pz1-30, pz1-40]. */
function variantsByDish(menu) {
  const out = {};
  for (const v of menu) (out[v.dishId] ||= []).push(v);
  const suffix = v => Number(v.variantId.split('-')[1]) || 0;
  for (const list of Object.values(out)) list.sort((a, b) => suffix(a) - suffix(b));
  return out;
}

/** Позиция корзины сайта → variantId Флагмана (null — блюда нет на складе) */
function toVariant(byDish, line) {
  const list = byDish[line.id];
  if (!list?.length) return null;
  const idx = variantIndex(BY_ID[line.id], line);
  return list[Math.min(idx, list.length - 1)].variantId;
}

/** Обратное сопоставление: variantId → { id, size, variant } позиции сайта */
function fromVariant(byDish, variantId) {
  for (const [dishId, list] of Object.entries(byDish)) {
    const idx = list.findIndex(v => v.variantId === variantId);
    if (idx < 0) continue;
    const item = BY_ID[dishId];
    return { id: dishId, size: item?.variantOpts ? 0 : idx, variant: item?.variantOpts ? idx : 0 };
  }
  return null;
}

async function hotByDish(loc) {
  try {
    const r = await flagman.hotOffers(loc);
    const byDish = {};
    (r.offers || []).forEach((o, i) => {
      const dishId = o.variantId.split('-')[0];
      if (byDish[dishId]) return;
      // Оценка склада — в копейках «спасённого», её шкала зависит от цен; для витрины важен порядок: 1-е место — 100
      const priority = Math.max(10, 100 - (o.rank - 1) * 15);
      byDish[dishId] = {
        offer: o,
        priority,
        level: o.rank <= 2 ? 'high' : o.rank <= 5 ? 'medium' : 'low',
        reason_public: PUBLIC_REASONS[i % PUBLIC_REASONS.length],
      };
    });
    return { byDish, error: r.error || null };
  } catch (e) {
    return { byDish: {}, error: e.message };
  }
}

/** Меню сайта с наличием со склада — тот же формат, что у демо-режима сайта. */
/**
 * @param staff — запрос персонала (касса): к горячему предложению добавляем настоящую причину
 *                («Лосось истекает через 14 ч»). Гость видит только нейтральную фразу.
 */
async function menuPayload(loc, { staff = false } = {}) {
  const menu = await flagman.menu(loc);
  const byDish = variantsByDish(menu);
  const hot = await hotByDish(loc);
  const items = ITEMS.map(it => {
    const vs = byDish[it.id] || [];
    const sellable = vs.map(v => !v.inStop);
    const available = vs.length ? sellable.some(Boolean) : true;
    const stopped = vs.find(v => v.inStop);
    const low = vs.filter(v => !v.inStop && v.low).map(v => v.portions);
    const h = hot.byDish[it.id];
    return {
      ...it,
      available,
      stop_reason: available ? null : stopped?.limitingProductName ? `Не хватает: ${stopped.limitingProductName.toLowerCase()}` : 'Нет в наличии',
      variants_available: vs.length > 1 ? sellable : undefined,
      portions_left: available && low.length ? Math.max(...low) : null,
      hot: h ? { priority: h.priority, level: h.level, reason_public: h.reason_public,
        ...(staff ? { reason: h.offer.explanation, saves_rub: Math.round((h.offer.lossKop || 0) / 100) } : {}) } : null,
      // Кассе — точное число порций по размерам: «осталось N» видно сразу, а не только на последних
      ...(staff ? { stock: stockOf(vs) } : {}),
    };
  });
  return { categories: CATEGORIES, items, updated_at: new Date().toISOString(), source: 'flagman' };
}

/**
 * Сколько ещё можно пробить каждой позиции, если отправить корзину кассы (касса: «осталось 5, 4, 3…»).
 * lines — позиции корзины сайта { id, size, variant, qty }. Ответ — по позициям сайта:
 * { [id]: { portions, variants } }, portions — максимум по размерам, variants — по каждому размеру.
 * Склад вычитает корзину по продуктам, поэтому учтены общие продукты: два ролла уменьшают и поке.
 */
async function leftAfterCart(loc, lines) {
  const byDish = variantsByDish(await flagman.menu(loc));
  const cart = [];
  for (const l of lines || []) {
    const variantId = BY_ID[l.id] ? toVariant(byDish, l) : null;
    const qty = Math.min(100, Math.max(0, Math.floor(Number(l.qty) || 0)));
    if (variantId && qty) cart.push({ variantId, qty });
  }
  const after = variantsByDish(await flagman.menuLeft(loc, cart.slice(0, 100)));
  const out = {};
  for (const it of ITEMS) {
    const s = stockOf(after[it.id] || []);
    if (s) out[it.id] = s;
  }
  return out;
}

/** Порции по размерам позиции сайта (null — этот размер склад не считает) и максимум по ним. */
function stockOf(vs) {
  const variants = vs.map(v => (!v.tracked ? null : v.inStop ? 0 : v.portions));
  const counted = variants.filter(n => n !== null);
  return counted.length ? { portions: Math.max(...counted), variants } : null;
}

/**
 * Отказ склада (409) → формат сайта: какие позиции не собрать, «максимум N»,
 * чего не хватает и похожие доступные блюда.
 */
function refusalToSite(refusal, lines, byDish) {
  const maxByVariant = Object.fromEntries((refusal.maxima || []).map(m => [m.variantId, m.max]));
  const missing = (refusal.shortages || []).map(s => ({ product_id: s.productId, name: s.productName, need: s.needText, available: s.availableText }));
  const unavailable = lines.filter(l => l.variantId in maxByVariant).map(l => ({
    id: l.id, name: l.name, size: l.size, variant: l.variant, qty: l.qty,
    max_qty: maxByVariant[l.variantId],
    missing,
  }));
  const alternatives = (refusal.alternatives || []).map(a => {
    const site = fromVariant(byDish, a.variantId);
    const item = site && BY_ID[site.id];
    return item ? { ...site, name: a.name, price: price(item, site.size), portions: a.portions, hot: a.hot, photo: item.photo } : null;
  }).filter(Boolean);
  return {
    ok: false,
    code: 'OUT_OF_STOCK',
    error: refusal.message || 'Недостаточно продуктов',
    unavailable: unavailable.length ? unavailable : lines.map(l => ({ id: l.id, name: l.name, size: l.size, variant: l.variant, qty: l.qty, max_qty: 0, missing })),
    alternatives,
  };
}

module.exports = {
  CATEGORIES, ITEMS, BY_ID, price, variantsByDish, toVariant, fromVariant, leftAfterCart,
  menuPayload, refusalToSite,
};
