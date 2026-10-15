// ═══════════════════════════════════════════════════════════════
//  Сайт — состояние: город, корзина, мои заказы, меню
// ═══════════════════════════════════════════════════════════════
import { CONFIG } from '../../../shared/js/config.js';
import { store } from '../../../shared/js/utils.js';
import { ALL_ITEMS, CATEGORIES } from '../../../shared/js/menu-catalog.js';

const bus = new EventTarget();
/** Подписка на событие; возвращает функцию отписки */
export function on(type, fn) {
  const h = e => fn(e.detail);
  bus.addEventListener(type, h);
  return () => bus.removeEventListener(type, h);
}
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

// ── Город ──────────────────────────────────────────────────────
// миграция со старого сайта (bb_location)
const legacyLoc = (() => { try { return localStorage.getItem('bb_location'); } catch { return null; } })();
let loc = store.get('istok_loc', null) || (legacyLoc && CONFIG.LOCATIONS[legacyLoc] ? legacyLoc : null);

export const getLoc = () => loc;
export const locInfo = () => CONFIG.LOCATIONS[loc] || null;
export function setLoc(code) {
  if (!CONFIG.LOCATIONS[code] || code === loc) return;
  loc = code;
  store.set('istok_loc', code);
  emit('loc', code);
}

// ── Меню ───────────────────────────────────────────────────────
export const menu = {
  categories: CATEGORIES,
  items: ALL_ITEMS.map(i => ({ ...i, available: true, hot: null })),
  byId: {},
  loaded: false,
};
export function setMenu(data) {
  menu.categories = data.categories?.length ? data.categories : CATEGORIES;
  menu.items = data.items;
  menu.byId = Object.fromEntries(data.items.map(i => [i.id, i]));
  menu.loaded = true;
  emit('menu', menu);
}
menu.byId = Object.fromEntries(menu.items.map(i => [i.id, i]));

// ── Корзина ────────────────────────────────────────────────────
// line: { key, id, name, price, qty, size, variant, photo }
let cart = store.get('istok_cart', []);
if (!Array.isArray(cart)) cart = [];

export const getCart = () => cart;
const persist = () => { store.set('istok_cart', cart); emit('cart', cart); };

export function lineKey(id, size = 0, variant = 0) { return `${id}|s${size}|v${variant}`; }

/** Название позиции с учётом размера/варианта — как в старом сайте */
export function lineName(item, size = 0, variant = 0) {
  let name = item.name;
  if (item.variantOpts) {
    const vName = item.variantNames?.[variant];
    name = vName || `${item.name} ${item.variantOpts[variant].toLowerCase()}`;
  }
  if (item.pizza && item.price2) name += size === 1 ? ', 40 см' : ', 30 см';
  else if (item.sizes && item.price2) name += `, ${item.sizes[size].toLowerCase()}`;
  return name;
}
export const linePrice = (item, size = 0) => (size === 1 && item.price2 ? item.price2 : item.price);

export function addToCart(item, { size = 0, variant = 0, qty = 1 } = {}) {
  const key = lineKey(item.id, size, variant);
  const ex = cart.find(l => l.key === key);
  if (ex) ex.qty = Math.min(99, ex.qty + qty);
  else cart.push({ key, id: item.id, name: lineName(item, size, variant), price: linePrice(item, size), qty, size, variant, photo: item.photo });
  persist();
  return key;
}
export function changeQty(key, d) {
  const l = cart.find(x => x.key === key);
  if (!l) return;
  l.qty += d;
  if (l.qty <= 0) cart = cart.filter(x => x.key !== key);
  persist();
}
export function removeLine(key) { cart = cart.filter(x => x.key !== key); persist(); }
export function removeIds(ids) { const s = new Set(ids); cart = cart.filter(x => !s.has(x.id)); persist(); }
export function clearCart() { cart = []; persist(); }
export const cartCount = () => cart.reduce((s, l) => s + l.qty, 0);
export const cartTotal = () => cart.reduce((s, l) => s + l.qty * l.price, 0);
export const qtyInCart = id => cart.filter(l => l.id === id).reduce((s, l) => s + l.qty, 0);
/** Позиции корзины, которые сейчас в стоп-листе */
export const unavailableInCart = () => cart.filter(l => menu.byId[l.id] && menu.byId[l.id].available === false);

export function deliveryFee(total, type) {
  return type === 'delivery' && total < CONFIG.DELIVERY.freeFrom ? CONFIG.DELIVERY.fee : 0;
}

// ── Мои заказы (трекинг) ───────────────────────────────────────
const ORDERS_KEY = 'istok_my_orders';
const TTL = 48 * 3600e3;

// Миграция трекинга со старого сайта (bb_orders_list), чтобы клиент не потерял свои заказы
(() => {
  try {
    if (localStorage.getItem(ORDERS_KEY) !== null) return;
    const old = JSON.parse(localStorage.getItem('bb_orders_list') || '[]');
    if (Array.isArray(old) && old.length) store.set(ORDERS_KEY, old.filter(o => o.orderNumber));
  } catch {}
})();
export function myOrders() {
  const list = store.get(ORDERS_KEY, []);
  const fresh = (Array.isArray(list) ? list : []).filter(o => o.orderNumber && Date.now() - (o.savedAt || 0) < TTL);
  if (fresh.length !== list.length) store.set(ORDERS_KEY, fresh);
  return fresh;
}
export function saveMyOrder(o) {
  const list = myOrders().filter(x => x.orderNumber !== o.orderNumber);
  list.unshift({ ...o, savedAt: Date.now() });
  store.set(ORDERS_KEY, list.slice(0, 10));
  emit('orders', myOrders());
}
export function updateMyOrder(num, patch) {
  const list = myOrders();
  const o = list.find(x => x.orderNumber === num);
  if (o) { Object.assign(o, patch); store.set(ORDERS_KEY, list); emit('orders', list); }
}
export function removeMyOrder(num) {
  store.set(ORDERS_KEY, myOrders().filter(x => x.orderNumber !== num));
  emit('orders', myOrders());
}
export const activeOrders = () => myOrders().filter(o => ![CONFIG.STATUS.DONE, CONFIG.STATUS.CANCELLED].includes(o.status));
