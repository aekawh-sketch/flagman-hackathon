// ═══════════════════════════════════════════════════════════════
//  ИСТОК — движок склада (эталонная логика для бэкенда)
//
//  Чистые функции над объектом состояния точки (state). В демо-режиме
//  работают прямо в браузере; бэкенду нужно воспроизвести ту же логику
//  (см. API_CONTRACT.md → «Алгоритмы»).
//
//  Ключевые правила:
//   • Остаток продукта = сумма qty по НЕпросроченным партиям.
//   • Списание по FEFO: сначала партии с самым ранним сроком годности.
//   • Блюдо в стоп-листе, если хотя бы одного ингредиента меньше,
//     чем нужно на 1 порцию.
//   • Заказ отклоняется целиком, если хоть одной позиции не хватает
//     ингредиентов (с учётом суммарной потребности всего заказа).
// ═══════════════════════════════════════════════════════════════
import { PRODUCTS, PRODUCT_BY_ID, RECIPES, VARIANT_SWAPS, SIZE_SWAPS, RECIPE_COMBOS, DEMO_SCENARIO, SUPPLIERS } from './seed.js';
import { ALL_ITEMS, ITEM_BY_ID } from '../menu-catalog.js';

export const HOT_HORIZON_H = 72;
export const STATE_VERSION = 6;   // меняйте, если поменялась структура демо-данных   // горизонт «риска» для горячих предложений
const H = 3600e3;

// ── Детерминированный ГСЧ (чтобы демо было стабильным) ─────────
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const round = (v, step = 1) => Math.round(v / step) * step;
const hoursLeft = (b, now) => (new Date(b.expires_at).getTime() - now) / H;

// ═══════════════════════════════════════════════════════════════
//  ПОТРЕБНОСТЬ
// ═══════════════════════════════════════════════════════════════

/**
 * Состав одной порции позиции с учётом размера и варианта.
 * size: 0 — базовый, 1 — второй (price2); variant — индекс variantOpts.
 */
export function requirement(dishId, size = 0, variant = 0) {
  const base = RECIPES[dishId];
  if (!base) return {};
  const item = ITEM_BY_ID[dishId];
  const sizeSwap = size === 1 ? SIZE_SWAPS[dishId] : null;
  const factor = size === 1 && item?.price2 && !sizeSwap ? item.price2 / item.price : 1;
  const swap = { ...(VARIANT_SWAPS[dishId]?.[variant] || {}), ...(sizeSwap || {}) };
  const out = {};
  for (const [pid, q] of Object.entries(base)) {
    const target = swap[pid] || pid;
    const unit = PRODUCT_BY_ID[target].unit;
    const v = q * factor;
    out[target] = (out[target] || 0) + (unit === 'pcs' ? Math.ceil(v - 1e-9) : Math.round(v));
  }
  return out;
}

/** Суммарная потребность заказа: items = [{id, qty, size?, variant?}] */
export function orderRequirement(items) {
  const need = {};
  for (const it of items) {
    if (!RECIPES[it.id]) continue;
    const r = requirement(it.id, it.size || 0, it.variant || 0);
    for (const [pid, q] of Object.entries(r)) need[pid] = (need[pid] || 0) + q * (it.qty || 1);
  }
  return need;
}

// ═══════════════════════════════════════════════════════════════
//  ОСТАТКИ
// ═══════════════════════════════════════════════════════════════

export function liveBatches(state, pid, now = Date.now()) {
  return state.batches
    .filter(b => b.product_id === pid && b.qty > 0 && hoursLeft(b, now) > 0)
    .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
}

export function available(state, pid, now = Date.now()) {
  let s = 0;
  for (const b of state.batches) if (b.product_id === pid && b.qty > 0 && hoursLeft(b, now) > 0) s += b.qty;
  return s;
}

export function availableMap(state, now = Date.now()) {
  const m = Object.fromEntries(PRODUCTS.map(p => [p.id, 0]));
  for (const b of state.batches) if (b.qty > 0 && hoursLeft(b, now) > 0) m[b.product_id] = (m[b.product_id] || 0) + b.qty;
  return m;
}

/** Чего не хватает под потребность need: [{product_id, name, unit, need, have}] */
export function shortages(need, avail) {
  const out = [];
  for (const [pid, q] of Object.entries(need)) {
    const have = avail[pid] || 0;
    if (have < q) out.push({ product_id: pid, name: PRODUCT_BY_ID[pid].name, unit: PRODUCT_BY_ID[pid].unit, need: q, have });
  }
  return out;
}

/** Среднесуточный расход продукта за последние N дней (из журнала расхода) */
export function dailyUsage(state, pid, days = 7, now = Date.now()) {
  return usageMap(state, days, now)[pid] || 0;
}

function usageMap(state, days = 7, now = Date.now()) {
  const from = now - days * 24 * H;
  const m = {};
  for (const u of state.usage) {
    const t = new Date(u.at).getTime();
    if (t >= from && t <= now) m[u.product_id] = (m[u.product_id] || 0) + u.qty;
  }
  for (const k in m) m[k] = Math.max(0, m[k] / days);
  return m;
}

/** Индексы вариантов блюда (для блюд без вариантов — [0]) */
const variantIdx = it => it?.variantOpts ? it.variantOpts.map((_, i) => i) : [0];

/** Сколько порций блюда можно приготовить из текущих остатков */
export function portionsLeft(dishId, avail, size = 0, variant = 0) {
  const req = requirement(dishId, size, variant);
  let n = Infinity;
  for (const [pid, q] of Object.entries(req)) n = Math.min(n, Math.floor((avail[pid] || 0) / q));
  return Number.isFinite(n) ? n : 0;
}

/** Сводка по складу: продукты + партии */
export function stockReport(state, now = Date.now()) {
  const avail = availableMap(state, now);
  const usage = usageMap(state, 7, now);
  const byProduct = {};
  for (const b of state.batches) {
    if (b.qty <= 0) continue;
    (byProduct[b.product_id] ||= []).push(b);
  }
  return PRODUCTS.map(p => {
    const batches = (byProduct[p.id] || [])
      .map(b => ({ ...b, hours_left: +hoursLeft(b, now).toFixed(1), expired: hoursLeft(b, now) <= 0 }))
      .sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
    const live = batches.filter(b => !b.expired);
    const nearest = live[0];
    const daily = usage[p.id] || 0;
    return {
      product_id: p.id, name: p.name, unit: p.unit, group: p.group, cost: p.cost, shelf_hours: p.shelf_hours,
      qty: avail[p.id] || 0,
      expired_qty: batches.filter(b => b.expired).reduce((s, b) => s + b.qty, 0),
      batches_count: live.length,
      nearest_expiry: nearest?.expires_at || null,
      nearest_hours_left: nearest ? nearest.hours_left : null,
      daily_usage: Math.round(daily),
      cover_days: daily > 0 ? +((avail[p.id] || 0) / daily).toFixed(1) : null,
      value: Math.round(((avail[p.id] || 0) / (p.unit === 'pcs' ? 1 : 1000)) * p.cost),
      batches,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
//  СТОП-ЛИСТ
// ═══════════════════════════════════════════════════════════════

/**
 * Стоп-лист. Блюдо с вариантами в стопе, только если недоступны ВСЕ варианты;
 * частично доступные отдаются в variants_available (для отключения в выборе варианта).
 */
export function stopList(state, now = Date.now()) {
  return availability(state, now).filter(a => !a.available).map(({ available, ...a }) => a);
}

/** Доступность каждого блюда: { id, available, variants_available?, missing, reason, portions_left } */
export function availability(state, now = Date.now()) {
  const avail = availableMap(state, now);
  const out = [];
  for (const it of ALL_ITEMS) {
    if (!RECIPES[it.id]) continue;
    const vs = variantIdx(it).map(v => shortages(requirement(it.id, 0, v), avail));
    const okVariants = vs.map(m => !m.length);
    const available = okVariants.some(Boolean);
    const miss = vs.find(m => m.length) || [];
    out.push({
      id: it.id, name: it.name, cat: it.cat, available,
      variants_available: it.variantOpts ? okVariants : undefined,
      missing: available ? [] : vs[0], reason: available ? null : reasonMissing(vs[0]),
      partial_missing: available && miss.length ? miss : undefined,
      portions_left: Math.max(...variantIdx(it).map(v => portionsLeft(it.id, avail, 0, v))),
    });
  }
  return out;
}

export function reasonMissing(miss) {
  return 'Не хватает: ' + miss.map(m => m.name.toLowerCase()).join(', ');
}

// ═══════════════════════════════════════════════════════════════
//  СПИСАНИЕ FEFO
// ═══════════════════════════════════════════════════════════════

/** Списывает need со склада по FEFO. Возвращает движения по партиям. */
export function consumeFEFO(state, need, { now = Date.now(), ref = '' } = {}) {
  const moves = [];
  for (const [pid, total] of Object.entries(need)) {
    let left = total;
    for (const b of liveBatches(state, pid, now)) {
      if (left <= 0) break;
      const take = Math.min(b.qty, left);
      b.qty = +(b.qty - take).toFixed(3);
      left -= take;
      moves.push({ batch_id: b.id, batch_no: b.batch_no, product_id: pid, qty: take });
    }
    state.usage.push({ product_id: pid, qty: total - Math.max(0, left), at: new Date(now).toISOString(), ref });
  }
  return moves;
}

/** Автосписание просроченных партий. Возвращает новые записи списаний. */
export function expireSweep(state, now = Date.now()) {
  const created = [];
  for (const b of state.batches) {
    if (b.qty > 0 && hoursLeft(b, now) <= 0) {
      const p = PRODUCT_BY_ID[b.product_id];
      const w = {
        id: ++state.seq.writeoff,
        product_id: b.product_id, name: p.name, unit: p.unit,
        batch_id: b.id, batch_no: b.batch_no,
        qty: b.qty, reason: 'expired', reason_label: 'Истёк срок годности',
        cost: Math.round((b.qty / (p.unit === 'pcs' ? 1 : 1000)) * p.cost),
        at: new Date(now).toISOString(), auto: true,
      };
      b.qty = 0;
      b.written_off = true;
      state.writeoffs.push(w);
      created.push(w);
    }
  }
  return created;
}

// ═══════════════════════════════════════════════════════════════
//  ГОРЯЧИЕ ПРЕДЛОЖЕНИЯ
// ═══════════════════════════════════════════════════════════════
/*
  Для каждого продукта p с партиями, истекающими в горизонте H (72 ч):
    urgency_p   = max по партиям (1 − hoursLeft/H)                    ∈ [0..1]
    atRisk_p    = Σ qty этих партий
    expected_p  = суточный расход × hoursLeft_min / 24   (уйдёт само)
    surplus_p   = max(0, atRisk_p − expected_p)           (иначе спишем)
    wasteShare  = surplus_p / atRisk_p
    value_p     = clamp(log10(1 + surplus_p в ₽ / 100) / 1.5, 0.3, 1)   (дорогой риск важнее)
  Для блюда d (только доступные, не в стоп-листе):
    share_pd    = amount_pd / max amount_p среди доступных блюд  (чем больше продукта в блюде — тем лучше)
    spread_p    = 1 / √(число доступных блюд с p)               (редкий продукт — каждое блюдо важнее)
    score_d     = Σ_p 100 · urgency_p^1.5 · (0.15 + 0.85·wasteShare_p) · value_p
                         · (0.4 + 0.6·share_pd) · (0.6 + 0.4·spread_p)
  priority = min(100, round(score_d)); в выдачу — priority ≥ 12, топ-12.
*/
export function hotOffers(state, { limit = 12, now = Date.now() } = {}) {
  const avail = availableMap(state, now);
  const usage = usageMap(state, 7, now);
  const stopped = new Set(stopList(state, now).map(s => s.id));

  // Продукты под риском
  const risk = {};
  for (const b of state.batches) {
    if (b.qty <= 0) continue;
    const hl = hoursLeft(b, now);
    if (hl <= 0 || hl > HOT_HORIZON_H) continue;
    const r = (risk[b.product_id] ||= { qty: 0, minH: Infinity, urgency: 0, batch: null });
    r.qty += b.qty;
    if (hl < r.minH) { r.minH = hl; r.batch = b; }
    r.urgency = Math.max(r.urgency, 1 - hl / HOT_HORIZON_H);
  }
  for (const [pid, r] of Object.entries(risk)) {
    const p = PRODUCT_BY_ID[pid];
    const expected = (usage[pid] || 0) * r.minH / 24;
    r.expected = expected;
    r.surplus = Math.max(0, r.qty - expected);
    r.wasteShare = r.qty > 0 ? r.surplus / r.qty : 0;
    const surplusRub = (r.surplus / (p.unit === 'pcs' ? 1 : 1000)) * p.cost;
    r.value = Math.min(1, Math.max(0.3, Math.log10(1 + surplusRub / 100) / 1.5));
  }

  // Сколько доступных блюд использует продукт и максимальная норма продукта в блюде
  const dishesUsing = {}, maxAmount = {};
  for (const it of ALL_ITEMS) {
    if (stopped.has(it.id) || !RECIPES[it.id]) continue;
    for (const [pid, q] of Object.entries(RECIPES[it.id])) {
      dishesUsing[pid] = (dishesUsing[pid] || 0) + 1;
      if (it.cat !== 'sets') maxAmount[pid] = Math.max(maxAmount[pid] || 0, q);  // сеты не задают норму
    }
  }

  const avMap = Object.fromEntries(availability(state, now).map(a => [a.id, a]));
  const out = [];
  for (const it of ALL_ITEMS) {
    if (stopped.has(it.id) || !RECIPES[it.id]) continue;
    const va = avMap[it.id]?.variants_available;
    const req = requirement(it.id, 0, va ? Math.max(0, va.indexOf(true)) : 0);
    let score = 0;
    const factors = [];
    for (const [pid, amount] of Object.entries(req)) {
      const r = risk[pid];
      if (!r) continue;
      const share = Math.min(1, amount / (maxAmount[pid] || amount));
      const spread = 1 / Math.sqrt(dishesUsing[pid] || 1);
      const s = 100 * Math.pow(r.urgency, 1.5) * (0.15 + 0.85 * r.wasteShare) * r.value * (0.4 + 0.6 * share) * (0.6 + 0.4 * spread);
      if (s < 1) continue;
      score += s;
      const p = PRODUCT_BY_ID[pid];
      factors.push({
        product_id: pid, name: p.name, unit: p.unit, amount,
        hours_left: +r.minH.toFixed(1), at_risk: Math.round(r.qty), surplus: Math.round(r.surplus),
        batch_no: r.batch?.batch_no, contribution: Math.round(s),
      });
    }
    if (!factors.length) continue;
    // сет из N роллов не должен обгонять сами роллы только за счёт суммы: нормируем на √N
    if (RECIPE_COMBOS[it.id]) score /= Math.sqrt(RECIPE_COMBOS[it.id].length);
    const priority = Math.min(100, Math.round(score));
    if (priority < 12) continue;
    factors.sort((a, b) => b.contribution - a.contribution);
    const main = factors[0];
    out.push({
      id: it.id, name: it.name, cat: it.cat, price: it.price, photo: it.photo,
      priority,
      level: priority >= 70 ? 'high' : priority >= 40 ? 'medium' : 'low',
      reason: factors.map(f =>
        `${f.name}: партия ${f.batch_no} истекает через ${fmtH(f.hours_left)}, под риском ${fmtQ(f.at_risk, f.unit)}` +
        (f.surplus > 0 ? ` (≈${fmtQ(f.surplus, f.unit)} не успеет уйти при обычном спросе)` : '') +
        `; в блюде ${fmtQ(f.amount, f.unit)}`).join('. '),
      reason_short: `${main.name} — истекает через ${fmtH(main.hours_left)}`,
      reason_public: ['Выбор шефа на сегодня', 'Особенно хорошо сегодня', 'Свежая партия — пробуйте', 'Любимое у гостей сегодня', 'Готовим с особым вниманием'][out.length % 5],
      factors,
    });
  }
  out.sort((a, b) => b.priority - a.priority);
  return out.slice(0, limit);
}

function fmtH(h) { return h < 1 ? 'меньше часа' : h < 48 ? `${Math.round(h)} ч` : `${Math.round(h / 24)} дн`; }
function fmtQ(q, unit) {
  if (unit === 'g' && q >= 1000) return `${(q / 1000).toFixed(1).replace('.', ',')} кг`;
  if (unit === 'ml' && q >= 1000) return `${(q / 1000).toFixed(1).replace('.', ',')} л`;
  return `${Math.round(q)} ${{ g: 'г', ml: 'мл', pcs: 'шт' }[unit]}`;
}

// ═══════════════════════════════════════════════════════════════
//  ПРОГНОЗ СТОП-ЛИСТА
// ═══════════════════════════════════════════════════════════════
/*
  Для каждого продукта моделируем остаток по часам на 72 ч вперёд:
  каждый час — расход = суточный/24 (по FEFO), затем сгорают просроченные партии.
  Блюдо уходит в стоп в первый час t, когда остаток любого ингредиента < нормы.
*/
export function stopForecast(state, { horizon = 72, now = Date.now() } = {}) {
  const usage = usageMap(state, 7, now);
  const curve = {};
  for (const p of PRODUCTS) {
    const bs = liveBatches(state, p.id, now).map(b => ({ qty: b.qty, exp: hoursLeft(b, now) }));
    const hourly = (usage[p.id] || 0) / 24;
    const pts = [bs.reduce((s, b) => s + b.qty, 0)];
    for (let t = 1; t <= horizon; t++) {
      let need = hourly;
      for (const b of bs) { if (need <= 0) break; if (b.exp <= t - 1) continue; const take = Math.min(b.qty, need); b.qty -= take; need -= take; }
      pts.push(bs.filter(b => b.exp > t).reduce((s, b) => s + b.qty, 0));
    }
    curve[p.id] = pts;
  }
  const stopped = new Set(stopList(state, now).map(s => s.id));
  const out = [];
  for (const it of ALL_ITEMS) {
    if (stopped.has(it.id) || !RECIPES[it.id]) continue;
    let best = null;
    for (const [pid, amount] of Object.entries(requirement(it.id))) {
      const pts = curve[pid];
      const t = pts.findIndex(v => v < amount);
      if (t > 0 && (!best || t < best.hours)) {
        const exp = liveBatches(state, pid, now).some(b => Math.abs(hoursLeft(b, now) - t) < 1.01);
        best = { hours: t, product_id: pid, product_name: PRODUCT_BY_ID[pid].name, cause: exp ? 'expiry' : 'demand' };
      }
    }
    if (best) out.push({ id: it.id, name: it.name, cat: it.cat, ...best });
  }
  return out.sort((a, b) => a.hours - b.hours);
}

// ═══════════════════════════════════════════════════════════════
//  РЕКОМЕНДАЦИИ ПО ЗАКУПКЕ
// ═══════════════════════════════════════════════════════════════
/*
  usable   = остаток без партий, истекающих в ближайшие 24 ч
  cover    = usable / суточный расход   (дней)
  target   = суточный расход × 3 дня
  предложить, если cover < 1.5 дн или продукт держит блюда в стопе;
  qty      = target − usable, округлено вверх до кратности закупки (pack).
*/
export function purchaseSuggestions(state, now = Date.now()) {
  const usage = usageMap(state, 7, now);
  const stop = stopList(state, now);
  const blocking = {};
  for (const s of stop) for (const m of s.missing) (blocking[m.product_id] ||= []).push(s.name);
  const out = [];
  for (const p of PRODUCTS) {
    const daily = usage[p.id] || 0;
    const usable = liveBatches(state, p.id, now).filter(b => hoursLeft(b, now) > 24).reduce((s, b) => s + b.qty, 0);
    const cover = daily > 0 ? usable / daily : Infinity;
    const blocks = blocking[p.id] || [];
    if (cover >= 1.5 && !blocks.length) continue;
    if (daily === 0 && !blocks.length) continue;
    const target = Math.max(daily * 3, blocks.length ? p.pack : 0);
    const qty = Math.max(p.pack, Math.ceil((target - usable) / p.pack) * p.pack);
    out.push({
      product_id: p.id, name: p.name, unit: p.unit, group: p.group,
      available: Math.round(available(state, p.id, now)), usable: Math.round(usable),
      daily_usage: Math.round(daily), cover_days: isFinite(cover) ? +cover.toFixed(1) : null,
      suggest_qty: qty, est_cost: Math.round((qty / (p.unit === 'pcs' ? 1 : 1000)) * p.cost),
      priority: blocks.length || cover < 0.5 ? 'critical' : cover < 1 ? 'high' : 'normal',
      blocks_dishes: blocks.slice(0, 6), blocks_count: blocks.length,
      reason: blocks.length ? `Блюда в стопе: ${blocks.length}` : `Запаса на ${cover.toFixed(1).replace('.', ',')} дн`,
    });
  }
  const rank = { critical: 0, high: 1, normal: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority] || (a.cover_days ?? 0) - (b.cover_days ?? 0));
}

// ═══════════════════════════════════════════════════════════════
//  АНАЛИТИКА
// ═══════════════════════════════════════════════════════════════
export function analytics(state, { days = 7, now = Date.now() } = {}) {
  const from = now - days * 24 * H;
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const daysArr = [];
  for (let i = days - 1; i >= 0; i--) daysArr.push(dayKey(now - i * 24 * H));

  const wo = state.writeoffs.filter(w => new Date(w.at).getTime() >= from);
  const woByDay = Object.fromEntries(daysArr.map(d => [d, { cost: 0, count: 0 }]));
  const woByProduct = {};
  for (const w of wo) {
    const k = dayKey(w.at);
    if (woByDay[k]) { woByDay[k].cost += w.cost; woByDay[k].count++; }
    const r = (woByProduct[w.product_id] ||= { product_id: w.product_id, name: w.name, unit: w.unit, qty: 0, cost: 0, count: 0 });
    r.qty += w.qty; r.cost += w.cost; r.count++;
  }

  const def = {};
  for (const d of state.deficits.filter(d => new Date(d.at).getTime() >= from)) {
    const r = (def[d.product_id] ||= { product_id: d.product_id, name: PRODUCT_BY_ID[d.product_id]?.name || d.product_id, events: 0, rejected_orders: 0, dishes: new Set() });
    r.events++;
    if (d.kind === 'order_rejected') r.rejected_orders++;
    if (d.dish) r.dishes.add(d.dish);
  }

  const orders = state.orders.filter(o => new Date(o.created_at).getTime() >= from);
  const revByDay = Object.fromEntries(daysArr.map(d => [d, 0]));
  for (const o of orders) if (o.status !== 'Отменён') { const k = dayKey(o.created_at); if (k in revByDay) revByDay[k] += o.grand_total; }

  const stock = stockReport(state, now);
  return {
    days: daysArr,
    writeoffs_by_day: daysArr.map(d => ({ date: d, ...woByDay[d] })),
    writeoffs_top: Object.values(woByProduct).sort((a, b) => b.cost - a.cost).slice(0, 8),
    writeoffs_total_cost: wo.reduce((s, w) => s + w.cost, 0),
    writeoffs_total_count: wo.length,
    deficit_top: Object.values(def).map(d => ({ ...d, dishes: [...d.dishes].slice(0, 5) })).sort((a, b) => b.events - a.events).slice(0, 8),
    rejected_orders: state.deficits.filter(d => d.kind === 'order_rejected' && new Date(d.at).getTime() >= from).length,
    revenue_by_day: daysArr.map(d => ({ date: d, revenue: revByDay[d] })),
    stock_value: stock.reduce((s, p) => s + p.value, 0),
    products_total: stock.length,
    products_low: stock.filter(p => p.cover_days !== null && p.cover_days < 1).length,
  };
}

// ═══════════════════════════════════════════════════════════════
//  ПОСТАВКИ
// ═══════════════════════════════════════════════════════════════

/**
 * Приём поставки.
 * payload: { number?, supplier?, created_at?, items: [{ product_id, qty, expires_at? | shelf_hours? , produced_at? }] }
 * Срок годности партии: expires_at, либо produced_at/now + shelf_hours (по справочнику).
 */
export function receiveSupply(state, payload, now = Date.now()) {
  const items = (payload.items || []).filter(i => PRODUCT_BY_ID[i.product_id] && Number(i.qty) > 0);
  if (!items.length) return { ok: false, error: 'В поставке нет корректных позиций' };
  const id = ++state.seq.supply;
  const supply = {
    id,
    uuid: payload.uuid || `sup-${id}-${Math.random().toString(36).slice(2, 8)}`,
    number: payload.number || `П-${String(1000 + id)}`,
    supplier: payload.supplier || 'Не указан',
    created_at: payload.created_at || new Date(now).toISOString(),
    received_at: new Date(now).toISOString(),
    items: [],
    total_cost: 0,
  };
  for (const it of items) {
    const p = PRODUCT_BY_ID[it.product_id];
    const base = it.produced_at ? new Date(it.produced_at).getTime() : now;
    const expires = it.expires_at ? new Date(it.expires_at).getTime() : base + (Number(it.shelf_hours) || p.shelf_hours) * H;
    const bid = ++state.seq.batch;
    const batch = {
      id: bid, batch_no: `${supply.number}/${supply.items.length + 1}`,
      supply_id: id, supply_number: supply.number, supplier: supply.supplier,
      product_id: p.id, qty: Number(it.qty), initial_qty: Number(it.qty),
      received_at: supply.received_at, expires_at: new Date(expires).toISOString(),
    };
    state.batches.push(batch);
    const cost = Math.round((batch.qty / (p.unit === 'pcs' ? 1 : 1000)) * p.cost);
    supply.items.push({ product_id: p.id, name: p.name, unit: p.unit, qty: batch.qty, expires_at: batch.expires_at, batch_id: bid, batch_no: batch.batch_no, cost });
    supply.total_cost += cost;
  }
  state.supplies.push(supply);
  return { ok: true, supply };
}

// ═══════════════════════════════════════════════════════════════
//  ЗАКАЗЫ
// ═══════════════════════════════════════════════════════════════

/**
 * Проверка и проведение заказа.
 * Возвращает { ok:true, moves } или { ok:false, code:'OUT_OF_STOCK', unavailable:[...] }.
 */
export function checkAndConsume(state, items, { now = Date.now(), ref = '' } = {}) {
  const need = orderRequirement(items);
  const avail = availableMap(state, now);
  const miss = shortages(need, avail);
  if (miss.length) {
    const missing = new Set(miss.map(m => m.product_id));
    const unavailable = [];
    for (const it of items) {
      const r = requirement(it.id, it.size || 0, it.variant || 0);
      const lacks = Object.keys(r).filter(pid => missing.has(pid));
      if (lacks.length) unavailable.push({
        id: it.id, name: it.name || ITEM_BY_ID[it.id]?.name || it.id,
        size: it.size || 0, variant: it.variant || 0, qty: it.qty || 1,
        // сколько порций этой позиции можно собрать, если остальное в заказе не трогать
        max_qty: portionsLeft(it.id, avail, it.size || 0, it.variant || 0),
        missing: miss.filter(m => lacks.includes(m.product_id)),
      });
    }
    for (const m of miss) state.deficits.push({ product_id: m.product_id, kind: 'order_rejected', at: new Date(now).toISOString(), dish: unavailable[0]?.id });
    return {
      ok: false, code: 'OUT_OF_STOCK',
      error: `Недостаточно ингредиентов: ${unavailable.map(u => u.name).join(', ')}`,
      unavailable,
    };
  }
  const moves = consumeFEFO(state, need, { now, ref });
  return { ok: true, moves };
}

// ═══════════════════════════════════════════════════════════════
//  НАЧАЛЬНОЕ СОСТОЯНИЕ ДЕМО
// ═══════════════════════════════════════════════════════════════

export function createState(loc, now = Date.now()) {
  const rand = rng(loc === 'kan' ? 7331 : 1337);
  const state = {
    loc, seeded_at: new Date(now).toISOString(), version: STATE_VERSION,
    seq: { order: 1000, supply: 0, batch: 0, writeoff: 0, orderId: 0 },
    batches: [], supplies: [], writeoffs: [], usage: [], deficits: [], orders: [],
  };
  const scale = loc === 'kan' ? 0.75 : 1;

  // 1) История продаж за 10 дней → журнал расхода и бухгалтерия
  const sellable = ALL_ITEMS.filter(i => RECIPES[i.id]);
  const weights = sellable.map(i => (i.cat === 'burgers' || i.cat === 'pizza' ? 3 : i.cat === 'drinks' ? 2 : i.cat === 'sets' ? 0.6 : 1.4) * (0.5 + rand()));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const pick = () => { let r = rand() * wsum; for (let i = 0; i < sellable.length; i++) { r -= weights[i]; if (r <= 0) return sellable[i]; } return sellable[0]; };
  const names = ['Анна', 'Иван', 'Мария', 'Дмитрий', 'Елена', 'Сергей', 'Ольга', 'Алексей', 'Татьяна', 'Никита', 'Юлия', 'Павел'];
  const streets = ['ул. Солнечная, 3', 'ул. Ягодная, 5, кв. 3', 'Речной пр., 40', 'пер. Хлебный, 7', 'ул. Полевая, 18', 'ул. Зелёная, 21'];
  for (let d = 10; d >= 1; d--) {
    const nOrders = Math.round((26 + rand() * 14) * scale);
    const day = new Date(now - d * 24 * H);
    day.setHours(0, 0, 0, 0);
    for (let k = 0; k < nOrders; k++) {
      const created = new Date(day.getTime() + (10 + rand() * 12.5) * H);   // 10:00–22:30 того дня
      if (created.getTime() > now - 3 * H) continue;                        // история — только прошлое
      const nItems = 1 + Math.floor(rand() * 3.2);
      const items = [];
      for (let j = 0; j < nItems; j++) {
        const it = pick();
        const size = it.price2 && rand() < 0.35 ? 1 : 0;
        const price = size ? it.price2 : it.price;
        const ex = items.find(x => x.id === it.id && x.size === size);
        if (ex) ex.qty++; else items.push({ id: it.id, name: size && it.sizes ? `${it.name} (${it.sizes[1]})` : size && it.pizza ? `${it.name} (40 см)` : it.name, price, qty: 1, size });
      }
      const type = rand() < 0.55 ? 'delivery' : rand() < 0.5 ? 'pickup' : 'hall';
      const total = items.reduce((s, i) => s + i.price * i.qty, 0);
      const delivery_cost = type === 'delivery' && total < 1000 ? 150 : 0;
      const status = rand() < 0.05 ? 'Отменён' : 'Выполнен';
      state.orders.push(makeOrder(state, {
        customer: names[Math.floor(rand() * names.length)], phone: '+7 (000) 000-00-00',
        address: type === 'delivery' ? `${loc === 'kan' ? 'пос. Ясноречье' : 'г. Истокград'}, ${streets[Math.floor(rand() * streets.length)]}` : '',
        type, items, comment: '', payment: rand() < 0.6 ? 'card' : 'cash', source: 'history',
      }, { now: created.getTime(), status, total, delivery_cost }));
      if (status !== 'Отменён') {
        for (const [pid, q] of Object.entries(orderRequirement(items))) state.usage.push({ product_id: pid, qty: q, at: created.toISOString(), ref: 'history' });
      }
    }
  }

  // 2) Стартовые партии: покрытие 2–4 суток по фактическому расходу
  const daily = usageMap(state, 7, now);
  const scenario = DEMO_SCENARIO;
  const supplierFor = p => ({ meat: SUPPLIERS[0], poultry: SUPPLIERS[0], fish: SUPPLIERS[1], dairy: SUPPLIERS[4], veg: SUPPLIERS[5], bakery: SUPPLIERS[6], grocery: SUPPLIERS[7], sauce: SUPPLIERS[7], drinks: SUPPLIERS[8] }[p.group]);
  const plan = [];
  for (const p of PRODUCTS) {
    if (scenario[p.id]) { for (const s of scenario[p.id]) plan.push({ p, ...s, qty: Math.round(s.qty * scale) }); continue; }
    const d = Math.max(daily[p.id] || 0, p.unit === 'pcs' ? 4 : 120);
    const cover = 2.2 + rand() * 2;
    const total = d * cover;
    const shelf = p.shelf_hours;
    // старая партия (часть срока уже прошла) + свежая
    const oldShare = 0.35 + rand() * 0.25;
    const oldLeft = Math.max(6, shelf * (0.15 + rand() * 0.5));
    plan.push({ p, qty: total * oldShare, hoursLeft: oldLeft, supplier: supplierFor(p) });
    plan.push({ p, qty: total * (1 - oldShare), hoursLeft: Math.max(oldLeft + 12, shelf * (0.75 + rand() * 0.25)), supplier: supplierFor(p) });
  }
  // Группируем в поставки по поставщику, будто пришли в разные дни
  const bySupplier = {};
  for (const x of plan) (bySupplier[x.supplier] ||= []).push(x);
  for (const [supplier, rows] of Object.entries(bySupplier)) {
    // разносим по двум «поставкам»: старые и свежие партии
    const groups = [rows.filter(r => r.hoursLeft < r.p.shelf_hours * 0.7), rows.filter(r => r.hoursLeft >= r.p.shelf_hours * 0.7)];
    groups.forEach((g, gi) => {
      if (!g.length) return;
      const recvAgo = gi === 0 ? 48 + rand() * 24 : 4 + rand() * 20;
      const recvAt = now - recvAgo * H;
      const res = receiveSupply(state, {
        supplier, created_at: new Date(recvAt - 2 * H).toISOString(),
        items: g.map(r => ({ product_id: r.p.id, qty: roundQty(r.qty, r.p.unit), expires_at: new Date(now + r.hoursLeft * H).toISOString() })),
      }, recvAt);
      if (res.ok) res.supply.received_at = new Date(recvAt).toISOString();
    });
  }
  state.supplies.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));

  // 3) История списаний за неделю (для графиков)
  const perishable = PRODUCTS.filter(p => p.shelf_hours <= 120);
  for (let d = 7; d >= 1; d--) {
    const n = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const p = perishable[Math.floor(rand() * perishable.length)];
      const qty = roundQty((p.unit === 'pcs' ? 3 + rand() * 8 : 150 + rand() * 900) * scale, p.unit);
      state.writeoffs.push({
        id: ++state.seq.writeoff, product_id: p.id, name: p.name, unit: p.unit, batch_no: `П-${900 + Math.floor(rand() * 90)}/1`,
        qty, reason: 'expired', reason_label: 'Истёк срок годности',
        cost: Math.round((qty / (p.unit === 'pcs' ? 1 : 1000)) * p.cost),
        at: new Date(now - d * 24 * H + rand() * 6 * H).toISOString(), auto: true,
      });
    }
    // события дефицита
    if (rand() < 0.8) {
      const p = ['shrimp', 'dorblu', 'salmon', 'minced_meat', 'mozzarella', 'bun'][Math.floor(rand() * 6)];
      state.deficits.push({ product_id: p, kind: rand() < 0.5 ? 'order_rejected' : 'stop', at: new Date(now - d * 24 * H).toISOString() });
    }
  }
  state.deficits.push({ product_id: 'dorblu', kind: 'stop', at: new Date(now - 2 * H).toISOString(), dish: 'pz2' });
  state.deficits.push({ product_id: 'shrimp', kind: 'stop', at: new Date(now - 1 * H).toISOString(), dish: 'b16' });

  // 4) Немного «живых» заказов на сегодня
  const live = [
    { status: 'Новый', type: 'delivery', ago: 4 },
    { status: 'Готовится', type: 'pickup', ago: 11 },
    { status: 'Готовится', type: 'delivery', ago: 17 },
    { status: 'Готов к выдаче', type: 'delivery', ago: 26 },
    { status: 'В пути', type: 'delivery', ago: 38 },
    { status: 'Выполнен', type: 'pickup', ago: 70 },
  ];
  for (const l of live) {
    const items = [];
    for (let j = 0; j < 2 + Math.floor(rand() * 2); j++) { const it = pick(); items.push({ id: it.id, name: it.name, price: it.price, qty: 1 + (rand() < 0.2 ? 1 : 0) }); }
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    state.orders.push(makeOrder(state, {
      customer: names[Math.floor(rand() * names.length)], phone: `+7 (000) ${Math.floor(100 + rand() * 899)}-${Math.floor(10 + rand() * 89)}-${Math.floor(10 + rand() * 89)}`,
      address: l.type === 'delivery' ? `${loc === 'kan' ? 'пос. Ясноречье' : 'г. Истокград'}, ${streets[Math.floor(rand() * streets.length)]}` : '',
      type: l.type, items, comment: rand() < 0.4 ? 'Без лука, пожалуйста' : '', payment: 'card', source: 'site',
    }, { now: now - l.ago * 60e3, status: l.status, total, delivery_cost: l.type === 'delivery' && total < 1000 ? 150 : 0 }));
  }
  return state;
}

function roundQty(q, unit) {
  if (unit === 'pcs') return Math.max(1, Math.round(q));
  return Math.max(10, round(q, q > 2000 ? 100 : 10));
}

/** Создать запись заказа в формате старого API */
export function makeOrder(state, p, { now = Date.now(), status = 'Новый', total, delivery_cost = 0 } = {}) {
  const t = total ?? p.items.reduce((s, i) => s + i.price * i.qty, 0);
  const created = new Date(now);
  return {
    id: ++state.seq.orderId,
    order_number: ++state.seq.order,
    created_at: created.toISOString(),
    created_fmt: created.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    updated_at: created.toISOString(),
    customer: p.customer || '', phone: p.phone || '', address: p.address || '',
    type: p.type || 'pickup', status,
    items: p.items.map(i => ({ id: i.id, name: i.name, price: i.price, qty: i.qty, size: i.size || 0, variant: i.variant || 0 })),
    comment: p.comment || '', payment: p.payment || 'cash',
    table: p.table || '', zone: p.zone || '', source: p.source || 'site',
    total: t, delivery_cost, grand_total: t + delivery_cost,
    confirmed_by_client: false,
  };
}

/** Генератор случайной поставки (эмулятор событий) */
export function randomSupply(state, now = Date.now()) {
  const r = rng(now % 100000);
  const usage = usageMap(state, 7, now);
  // берём продукты с наименьшим покрытием + немного случайных
  const scored = PRODUCTS.map(p => ({ p, cover: (available(state, p.id, now) || 0) / Math.max(1, usage[p.id] || 1) }))
    .sort((a, b) => a.cover - b.cover);
  const chosen = [...scored.slice(0, 4), ...scored.slice(4).sort(() => r() - 0.5).slice(0, 3)].map(x => x.p);
  const supplier = SUPPLIERS[Math.floor(r() * SUPPLIERS.length)];
  return {
    supplier,
    items: chosen.map(p => ({
      product_id: p.id,
      qty: roundQty(Math.max(p.pack, (usage[p.id] || p.pack / 3) * (2 + r() * 2)), p.unit),
      shelf_hours: Math.round(p.shelf_hours * (0.6 + r() * 0.4)),
    })),
  };
}

/** Генератор случайного заказа: 1–3 позиции из доступных */
export function randomOrderItems(state, now = Date.now()) {
  const r = rng(now % 99991);
  const stopped = new Set(stopList(state, now).map(s => s.id));
  const pool = ALL_ITEMS.filter(i => RECIPES[i.id] && !stopped.has(i.id));
  const n = 1 + Math.floor(r() * 3);
  const items = [];
  for (let i = 0; i < n; i++) {
    const it = pool[Math.floor(r() * pool.length)];
    if (!items.find(x => x.id === it.id)) items.push({ id: it.id, name: it.name, price: it.price, qty: 1 });
  }
  return items;
}
