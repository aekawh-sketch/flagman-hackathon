// ═══════════════════════════════════════════════════════════════
//  ИСТОК — мок-бэкенд (работает в браузере)
//
//  Реализует ТОТ ЖЕ HTTP-контракт, что описан в API_CONTRACT.md,
//  но хранит данные в localStorage. Вкладки синхронизируются через
//  BroadcastChannel — заказ с сайта мгновенно появляется в панели.
// ═══════════════════════════════════════════════════════════════
import * as E from './engine.js';
import { PRODUCTS, PRODUCT_BY_ID, PRODUCT_GROUPS } from './seed.js';
import { CATEGORIES, ALL_ITEMS, ITEM_BY_ID } from '../menu-catalog.js';
import { CONFIG, DONE_STATUSES } from '../config.js';

const KEY = loc => `istok_mock_v${E.STATE_VERSION}_${loc}`;
const SESSION_KEY = 'istok_mock_session';
const RESEED_AFTER_H = 20;
const S = CONFIG.STATUS;

// ── Шина событий ───────────────────────────────────────────────
const listeners = new Set();
let channel = null;
try { channel = new BroadcastChannel('istok-mock'); } catch {}
if (channel) channel.onmessage = e => {
  const ev = e.data;
  if (ev?.loc) cache.delete(ev.loc);       // перечитать состояние, его поменяла другая вкладка
  for (const fn of listeners) fn(ev);
};
export function onMockEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(loc, type, data = {}) {
  const ev = { type, loc, data, at: new Date().toISOString() };
  for (const fn of listeners) fn(ev);
  try { channel?.postMessage(ev); } catch {}
}

// ── Состояние ──────────────────────────────────────────────────
const cache = new Map();
function load(loc) {
  if (cache.has(loc)) return cache.get(loc);
  let st = null;
  try { st = JSON.parse(localStorage.getItem(KEY(loc)) || 'null'); } catch {}
  const stale = !st || st.version !== E.STATE_VERSION || (Date.now() - new Date(st.seeded_at).getTime()) > RESEED_AFTER_H * 3600e3;
  if (stale) { st = E.createState(loc); save(st); }
  cache.set(loc, st);
  return st;
}
function save(st) {
  // журнал расхода ограничиваем 14 днями, чтобы не раздувать хранилище
  const from = Date.now() - 14 * 24 * 3600e3;
  st.usage = st.usage.filter(u => new Date(u.at).getTime() >= from);
  try { localStorage.setItem(KEY(st.loc), JSON.stringify(st)); }
  catch { /* переполнение — урезаем историю заказов */
    st.orders = st.orders.slice(-250);
    try { localStorage.setItem(KEY(st.loc), JSON.stringify(st)); } catch {}
  }
  cache.set(st.loc, st);
}

/** Перед каждым запросом: сгорают просроченные партии */
function tick(st) {
  const created = E.expireSweep(st);
  if (created.length) {
    save(st);
    emit(st.loc, 'writeoff.created', { items: created });
    emit(st.loc, 'stock.changed', {});
  }
}

/** Мутация с отслеживанием изменений стоп-листа и горячих предложений */
function mutate(st, fn) {
  const before = new Set(E.stopList(st).map(s => s.id));
  const res = fn();
  save(st);
  const after = E.stopList(st);
  const afterIds = new Set(after.map(s => s.id));
  const added = after.filter(s => !before.has(s.id));
  const removed = [...before].filter(id => !afterIds.has(id));
  if (added.length || removed.length) {
    for (const a of added) for (const m of a.missing) st.deficits.push({ product_id: m.product_id, kind: 'stop', at: new Date().toISOString(), dish: a.id });
    save(st);
    emit(st.loc, 'stoplist.changed', { added: added.map(a => ({ id: a.id, name: a.name })), removed });
  }
  return res;
}

// ── Хелперы ответа ─────────────────────────────────────────────
const ok = (json, status = 200) => ({ status, json });
const fail = (status, error, extra = {}) => ({ status, json: { ok: false, error, ...extra } });
const mockSession = () => {
  try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return s && s.exp > Date.now() ? s : null; } catch { return null; }
};
/** В панели — только выбравший место работы */
const authed = () => !!mockSession()?.user;
/** Демо без бэкенда: одно место работы — ИСТОК, обе точки */
const MOCK_WORKPLACES = [{ tenantName: 'ИСТОК', role: 'ADMIN', own: true,
  locations: Object.values(CONFIG.LOCATIONS).map(l => ({ id: l.code, name: l.city })) }];

const localDay = iso => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const todayStr = () => localDay(new Date().toISOString());

function normItems(items) {
  return (Array.isArray(items) ? items : []).map(i => ({
    id: String(i.id || ''), name: String(i.name || ITEM_BY_ID[i.id]?.name || i.id).slice(0, 120),
    price: Math.max(0, Number(i.price) || 0), qty: Math.max(1, Math.min(99, parseInt(i.qty) || 1)),
    size: Number(i.size) === 1 ? 1 : 0, variant: Math.max(0, parseInt(i.variant) || 0),
  })).filter(i => i.id);
}

/** Цена проверяется по каталогу (защита от подмены цены на клиенте) */
function priceCheck(items) {
  for (const i of items) {
    const m = ITEM_BY_ID[i.id];
    if (!m) continue;
    const expected = i.size === 1 && m.price2 ? m.price2 : m.price;
    if (i.price !== expected) i.price = expected;
  }
  return items;
}

const LOW_PORTIONS = 2;   // «осталось N порций» показываем при N ≤ 2

function menuPayload(st) {
  const av = Object.fromEntries(E.availability(st).map(a => [a.id, a]));
  const hot = Object.fromEntries(E.hotOffers(st).map(h => [h.id, h]));
  return {
    categories: CATEGORIES,
    items: ALL_ITEMS.map(it => {
      const a = av[it.id];
      return {
        ...it,
        available: a ? a.available : true,
        stop_reason: a && !a.available ? a.reason : null,
        variants_available: a?.variants_available,
        portions_left: a && a.available && a.portions_left <= LOW_PORTIONS ? a.portions_left : null,
        hot: hot[it.id] ? { priority: hot[it.id].priority, level: hot[it.id].level, reason_public: hot[it.id].reason_public } : null,
      };
    }),
    updated_at: new Date().toISOString(),
  };
}

function createOrder(st, body, { source = 'site', status = S.NEW } = {}) {
  const items = priceCheck(normItems(body.items));
  if (!items.length) return fail(400, 'Корзина пуста');
  const type = ['delivery', 'pickup', 'hall', 'terrace'].includes(body.type) ? body.type : 'pickup';
  if (source === 'site') {
    if (!String(body.customer || '').trim()) return fail(400, 'Укажите имя');
    if (String(body.phone || '').replace(/\D/g, '').length < 11) return fail(400, 'Укажите телефон');
    if (type === 'delivery' && String(body.address || '').trim().length < 8) return fail(400, 'Укажите адрес доставки');
  }
  return mutate(st, () => {
    const res = E.checkAndConsume(st, items, { ref: 'order' });
    if (!res.ok) return { status: 409, json: res };
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const delivery_cost = type === 'delivery' && total < CONFIG.DELIVERY.freeFrom ? CONFIG.DELIVERY.fee : 0;
    const order = E.makeOrder(st, {
      customer: String(body.customer || '').slice(0, 60), phone: String(body.phone || '').slice(0, 24),
      address: String(body.address || '').slice(0, 140), type, items,
      comment: String(body.comment || '').slice(0, 300), payment: body.payment === 'card' ? 'card' : 'cash',
      table: body.table || '', zone: body.zone || '', source,
    }, { status, total, delivery_cost });
    order.moves = res.moves;
    st.orders.push(order);
    emit(st.loc, 'order.created', { id: order.id, order_number: order.order_number, type: order.type, source });
    emit(st.loc, 'stock.changed', {});
    return ok({ ok: true, orderNumber: order.order_number, orderId: order.id, total, deliveryCost: delivery_cost, grandTotal: total + delivery_cost });
  });
}

/** Возврат ингредиентов при отмене заказа до начала готовки */
function restoreStock(st, order) {
  for (const m of order.moves || []) {
    const b = st.batches.find(x => x.id === m.batch_id);
    if (!b) continue;
    if (new Date(b.expires_at).getTime() > Date.now()) { b.qty = +(b.qty + m.qty).toFixed(3); continue; }
    // партия уже истекла — возвращать нечего, фиксируем списание
    const p = PRODUCT_BY_ID[b.product_id];
    st.writeoffs.push({
      id: ++st.seq.writeoff, product_id: p.id, name: p.name, unit: p.unit, batch_id: b.id, batch_no: b.batch_no,
      qty: m.qty, reason: 'expired', reason_label: 'Истёк срок (возврат после отмены)',
      cost: Math.round((m.qty / (p.unit === 'pcs' ? 1 : 1000)) * p.cost), at: new Date().toISOString(), auto: true,
    });
  }
  // убрать расход из журнала
  for (const [pid, q] of Object.entries(E.orderRequirement(order.items))) st.usage.push({ product_id: pid, qty: -q, at: new Date().toISOString(), ref: 'cancel' });
  order.moves = [];
}

function accounting(st, from, to) {
  const list = st.orders.filter(o => { const d = localDay(o.created_at); return (!from || d >= from) && (!to || d <= to); });
  const valid = list.filter(o => o.status !== S.CANCELLED);
  const summary = {
    total_orders: list.length,
    completed: list.filter(o => o.status === S.DONE).length,
    cancelled: list.filter(o => o.status === S.CANCELLED).length,
    deliveries: list.filter(o => o.type === 'delivery').length,
    pickups: list.filter(o => o.type !== 'delivery').length,
    revenue: valid.reduce((s, o) => s + o.grand_total, 0),
    delivery_fees: valid.reduce((s, o) => s + o.delivery_cost, 0),
    avg_order: valid.length ? valid.reduce((s, o) => s + o.grand_total, 0) / valid.length : 0,
  };
  const byDay = {};
  for (const o of list) {
    const d = localDay(o.created_at);
    const r = (byDay[d] ||= { date: d, total: 0, completed: 0, deliveries: 0, pickups: 0, revenue: 0, delivery_fees: 0 });
    r.total++;
    if (o.status === S.DONE) r.completed++;
    if (o.type === 'delivery') r.deliveries++; else r.pickups++;
    if (o.status !== S.CANCELLED) { r.revenue += o.grand_total; r.delivery_fees += o.delivery_cost; }
  }
  const byItem = {};
  for (const o of valid) for (const i of o.items) {
    const r = (byItem[i.name] ||= { name: i.name, quantity: 0, revenue: 0 });
    r.quantity += i.qty; r.revenue += i.qty * i.price;
  }
  return {
    summary,
    daily: Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date)),
    items: Object.values(byItem).sort((a, b) => b.revenue - a.revenue),
  };
}

function csv(rows) {
  return '﻿' + rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\r\n');
}

// ═══════════════════════════════════════════════════════════════
//  РОУТЕР
// ═══════════════════════════════════════════════════════════════
export async function mockFetch(method, path, body = null) {
  await new Promise(r => setTimeout(r, 90 + Math.random() * 160));   // имитация сети
  const url = new URL(path, 'http://mock');
  const p = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const q = Object.fromEntries(url.searchParams);
  method = method.toUpperCase();

  // ── Общие ──
  if (p === 'ping') return ok({ ok: true, mock: true, time: new Date().toISOString() });
  if (p === 'login' && method === 'POST') {
    if ((body?.password || '') !== CONFIG.MOCK_PASSWORD) return fail(401, 'Неверный пароль');
    // Демо без бэкенда: любой логин — админ ИСТОК со всеми разделами
    const login = String(body?.login || '').trim();
    const person = { login: login || 'service', name: login || 'Служебный вход', service: !login };
    localStorage.setItem(SESSION_KEY, JSON.stringify({ exp: Date.now() + 12 * 3600e3, person, user: null }));
    return ok({ ok: true, user: null, person, workplaces: MOCK_WORKPLACES });
  }
  if (p === 'workplace' && method === 'POST') {
    const s = mockSession();
    if (!s) return fail(401, 'Войдите в панель');
    const w = MOCK_WORKPLACES[0];
    if (!w.locations.some(l => l.id === body?.loc)) return fail(403, 'Вы не работаете в этой точке');
    s.user = { ...s.person, role: w.role, tenantName: w.tenantName, own: true, loc: body.loc, places: w.locations, multi: true };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    return ok({ ok: true, user: s.user });
  }
  if (p === 'logout') { localStorage.removeItem(SESSION_KEY); return ok({ ok: true }); }
  if (p === 'auth-check') {
    const s = mockSession();
    return ok({ ok: !!s?.user, user: s?.user || null, person: s?.person || null, workplaces: s ? MOCK_WORKPLACES : [] });
  }

  const m = p.match(/^(\w+)\/bb\/?(.*)$/);
  if (!m) return fail(404, 'Not found');
  const [, loc, rest] = m;
  if (!CONFIG.LOCATIONS[loc]) return fail(404, 'Unknown location');
  const st = load(loc);
  tick(st);

  // ── Публичные (сайт) ──
  if (rest === 'menu' && method === 'GET') return ok(menuPayload(st));
  if (rest === 'stoplist' && method === 'GET') return ok({ items: E.stopList(st), updated_at: new Date().toISOString() });
  if (rest === 'hot-offers' && method === 'GET') return ok({ items: E.hotOffers(st, { limit: Number(q.limit) || 12 }), updated_at: new Date().toISOString() });
  if (rest === 'order' && method === 'POST') return createOrder(st, body, { source: body?.source === 'kassir' ? 'kassir' : 'site' });
  let mm;
  if ((mm = rest.match(/^track\/(\d+)$/)) && method === 'GET') {
    const o = st.orders.find(x => x.order_number === Number(mm[1]));
    if (!o) return fail(404, 'Заказ не найден');
    return ok({ ok: true, order_number: o.order_number, status: o.status, type: o.type, updated_at: o.updated_at, created_at: o.created_at, grand_total: o.grand_total });
  }
  if ((mm = rest.match(/^confirm\/(\d+)$/)) && method === 'POST') {
    const o = st.orders.find(x => x.order_number === Number(mm[1]));
    if (!o) return fail(404, 'Заказ не найден');
    if (o.status === S.CANCELLED) return fail(409, 'Заказ отменён');
    o.status = S.DONE; o.confirmed_by_client = true; o.updated_at = new Date().toISOString();
    save(st); emit(loc, 'order.updated', { id: o.id, status: o.status });
    return ok({ ok: true });
  }

  // ── Дальше — только для персонала ──
  if (!authed()) return fail(401, 'Требуется вход');

  // Заказы (старый контракт)
  if (rest === 'orders' && method === 'GET') {
    const since = Date.now() - 24 * 3600e3;
    return ok(st.orders.filter(o => !DONE_STATUSES.includes(o.status) || new Date(o.created_at).getTime() >= since)
      .sort((a, b) => b.id - a.id).map(({ moves, ...o }) => o));
  }
  if ((mm = rest.match(/^orders\/(\d+)\/status$/)) && method === 'PATCH') {
    const o = st.orders.find(x => x.id === Number(mm[1]));
    if (!o) return fail(404, 'Заказ не найден');
    const status = body?.status;
    if (!Object.values(S).includes(status)) return fail(400, 'Неизвестный статус');
    return mutate(st, () => {
      if (status === S.CANCELLED && [S.NEW, S.ACCEPTED].includes(o.status)) restoreStock(st, o);
      o.status = status; o.updated_at = new Date().toISOString();
      emit(loc, 'order.updated', { id: o.id, status });
      if (status === S.CANCELLED) emit(loc, 'stock.changed', {});
      return ok({ ok: true });
    });
  }
  if (rest === 'stats' && method === 'GET') {
    const today = todayStr();
    const t = st.orders.filter(o => localDay(o.created_at) === today);
    const valid = st.orders.filter(o => o.status !== S.CANCELLED);
    return ok({
      total: t.length,
      cooking: st.orders.filter(o => [S.NEW, S.ACCEPTED, S.COOKING].includes(o.status)).length,
      on_way: st.orders.filter(o => o.status === S.ON_WAY).length,
      done: t.filter(o => o.status === S.DONE).length,
      revenue: valid.reduce((s, o) => s + o.grand_total, 0),
      revenue_today: t.filter(o => o.status !== S.CANCELLED).reduce((s, o) => s + o.grand_total, 0),
    });
  }
  if (rest === 'cashier' && method === 'POST') {
    const zoneType = body?.type === 'take' ? 'pickup' : body?.zone === 'terrace' ? 'terrace' : 'hall';
    return createOrder(st, { ...body, type: zoneType, customer: body?.table || 'Касса' }, { source: 'kassir', status: S.COOKING });
  }
  if (rest === 'fix-statuses' && method === 'POST') {
    let fixed = 0;
    for (const o of st.orders) if ([S.NEW, S.ACCEPTED].includes(o.status) && Date.now() - new Date(o.created_at).getTime() > 3 * 3600e3) { o.status = S.COOKING; fixed++; }
    save(st); emit(loc, 'order.updated', {});
    return ok({ ok: true, fixed });
  }
  if ((mm = rest.match(/^orders\/(clear-done|clear-active|all)$/)) && method === 'DELETE') {
    const before = st.orders.length;
    if (mm[1] === 'clear-done') st.orders = st.orders.filter(o => !DONE_STATUSES.includes(o.status));
    else if (mm[1] === 'clear-active') st.orders = st.orders.filter(o => DONE_STATUSES.includes(o.status));
    else { st.orders = []; st.seq.order = 1000; }
    save(st); emit(loc, 'order.updated', {});
    return ok({ ok: true, deleted: before - st.orders.length });
  }
  if (rest === 'export-today' && method === 'GET') {
    const today = todayStr();
    return ok({ ok: true, label: today, total: st.orders.filter(o => localDay(o.created_at) === today).length });
  }
  if ((mm = rest.match(/^accounting\/(summary|daily|items|excel)$/)) && method === 'GET') {
    const a = accounting(st, q.from, q.to);
    if (mm[1] === 'summary') return ok(a.summary);
    if (mm[1] === 'daily') return ok(a.daily);
    if (mm[1] === 'items') return ok(a.items);
    const rows = [['Отчёт ИСТОК', CONFIG.LOCATIONS[loc].name, `${q.from} — ${q.to}`], [],
      ['Дата', 'Заказов', 'Выполнено', 'Доставок', 'Самовывозов', 'Выручка', 'Доставка'],
      ...a.daily.map(d => [d.date, d.total, d.completed, d.deliveries, d.pickups, d.revenue, d.delivery_fees]), [],
      ['Блюдо', 'Продано, шт', 'Выручка'], ...a.items.map(i => [i.name, i.quantity, i.revenue])];
    return { status: 200, blob: new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }), filename: `ИСТОК ${q.from} — ${q.to}.csv` };
  }

  // ── Склад (новый контракт) ──
  if (rest === 'products' && method === 'GET') return ok({ groups: PRODUCT_GROUPS, items: PRODUCTS });
  if (rest === 'stock' && method === 'GET') {
    const products = E.stockReport(st);
    return ok({
      products,
      totals: {
        products: products.length,
        in_stock: products.filter(p => p.qty > 0).length,
        value: products.reduce((s, p) => s + p.value, 0),
        expiring_24h: products.reduce((s, p) => s + p.batches.filter(b => !b.expired && b.hours_left <= 24).length, 0),
        expiring_72h: products.reduce((s, p) => s + p.batches.filter(b => !b.expired && b.hours_left <= 72).length, 0),
      },
      updated_at: new Date().toISOString(),
    });
  }
  if (rest === 'batches' && method === 'GET') {
    const lim = Number(q.expiring_hours) || Infinity;
    const now = Date.now();
    return ok({
      items: st.batches.filter(b => b.qty > 0)
        .map(b => ({ ...b, name: PRODUCT_BY_ID[b.product_id].name, unit: PRODUCT_BY_ID[b.product_id].unit, hours_left: +((new Date(b.expires_at) - now) / 3600e3).toFixed(1) }))
        .filter(b => b.hours_left <= lim)
        .sort((a, b) => a.hours_left - b.hours_left),
    });
  }
  if (rest === 'supplies' && method === 'GET') return ok({ items: [...st.supplies].reverse().slice(0, Number(q.limit) || 50) });
  if (rest === 'supplies' && method === 'POST') {
    return mutate(st, () => {
      const r = E.receiveSupply(st, body || {});
      if (!r.ok) return fail(400, r.error);
      emit(loc, 'supply.received', { id: r.supply.id, number: r.supply.number, items: r.supply.items.length });
      emit(loc, 'stock.changed', {});
      return ok({ ok: true, supply: r.supply });
    });
  }
  if (rest === 'writeoffs' && method === 'GET') {
    const from = Date.now() - (Number(q.days) || 7) * 24 * 3600e3;
    return ok({ items: st.writeoffs.filter(w => new Date(w.at).getTime() >= from).sort((a, b) => new Date(b.at) - new Date(a.at)) });
  }
  if (rest === 'writeoffs' && method === 'POST') {
    const pr = PRODUCT_BY_ID[body?.product_id];
    const qty = Number(body?.qty);
    if (!pr || !(qty > 0)) return fail(400, 'Укажите продукт и количество');
    return mutate(st, () => {
      const need = { [pr.id]: qty };
      if (E.available(st, pr.id) < qty) return fail(409, 'На складе меньше, чем нужно списать');
      const moves = E.consumeFEFO(st, need, { ref: 'writeoff' });
      st.usage = st.usage.filter(u => u.ref !== 'writeoff');      // ручное списание — не «расход»
      const w = {
        id: ++st.seq.writeoff, product_id: pr.id, name: pr.name, unit: pr.unit,
        batch_no: moves.map(m => m.batch_no).join(', '), qty,
        reason: body.reason || 'other', reason_label: { damaged: 'Порча / брак', expired: 'Истёк срок годности', other: 'Другое' }[body.reason] || 'Другое',
        comment: String(body.comment || '').slice(0, 200),
        cost: Math.round((qty / (pr.unit === 'pcs' ? 1 : 1000)) * pr.cost), at: new Date().toISOString(), auto: false,
      };
      st.writeoffs.push(w);
      emit(loc, 'writeoff.created', { items: [w] });
      emit(loc, 'stock.changed', {});
      return ok({ ok: true, writeoff: w });
    });
  }
  if (rest === 'writeoffs/expire' && method === 'POST') {
    let created = [];
    mutate(st, () => { created = E.expireSweep(st); });
    if (created.length) { emit(loc, 'writeoff.created', { items: created }); emit(loc, 'stock.changed', {}); }
    return ok({ ok: true, created: created.length, items: created });
  }
  if (rest === 'forecast' && method === 'GET') return ok({ items: E.stopForecast(st, { horizon: Number(q.hours) || 72 }) });
  if (rest === 'purchase-suggestions' && method === 'GET') return ok({ items: E.purchaseSuggestions(st) });
  if (rest === 'analytics' && method === 'GET') return ok(E.analytics(st, { days: Number(q.days) || 7 }));

  // ── Эмулятор событий ──
  if (rest === 'simulate/supply' && method === 'POST') {
    return mutate(st, () => {
      const r = E.receiveSupply(st, E.randomSupply(st));
      emit(loc, 'supply.received', { id: r.supply.id, number: r.supply.number, items: r.supply.items.length, simulated: true });
      emit(loc, 'stock.changed', {});
      return ok({ ok: true, supply: r.supply });
    });
  }
  if (rest === 'simulate/order' && method === 'POST') {
    const items = E.randomOrderItems(st);
    const names = ['Алина', 'Игорь', 'Вера', 'Роман', 'Кира', 'Глеб'];
    return createOrder(st, {
      customer: names[Math.floor(Math.random() * names.length)], phone: '+7 (000) 111-22-33',
      address: `${CONFIG.LOCATIONS[loc].addrPrefix}ул. Садовая, ${1 + Math.floor(Math.random() * 60)}`,
      type: Math.random() < 0.6 ? 'delivery' : 'pickup', items, comment: 'Эмулятор',
    }, { source: 'simulator' });
  }
  if (rest === 'demo/reset' && method === 'POST') {
    const fresh = E.createState(loc);
    save(fresh);
    emit(loc, 'stock.changed', { reset: true });
    emit(loc, 'order.updated', {});
    return ok({ ok: true });
  }

  return fail(404, `Нет такого метода в демо-API: ${method} ${rest}`);
}
