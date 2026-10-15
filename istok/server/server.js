'use strict';
// ═══════════════════════════════════════════════════════════════════
//  ИСТОК — сервер ресторана: сайт, касса, заказы, курьер, бухгалтерия.
//  Склад (партии, сроки, FEFO, стоп-лист, антифрод) — «Флагман»:
//  сюда он подключён по API-ключу как внешняя система.
//  Панель персонала общая для ресторанов Флагмана: сотрудник входит своим
//  логином и выбирает место работы. Точки ИСТОК — как раньше; точки других
//  ресторанов — меню со склада, заказы в своей базе (lib/extdb.js), склад —
//  от имени сотрудника.
// ═══════════════════════════════════════════════════════════════════
const path         = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express      = require('express');
const fs           = require('fs');
const crypto       = require('crypto');
const XLSX         = require('xlsx');
const { Pool }     = require('pg');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');

const flagman      = require('./lib/flagman');
const catalog      = require('./lib/catalog');
const flagmenu     = require('./lib/flagmenu');
const extdb        = require('./lib/extdb');
const events       = require('./lib/events');

const app  = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', 'loopback');

// ═══════════════════════════════════════════════════════════════════
//  ТОЧКИ И БАЗЫ (по базе заказов на точку)
// ═══════════════════════════════════════════════════════════════════
const LOC_NAMES = { kush: 'Истокград', kan: 'Ясноречье' };
const VALID_LOCATIONS = new Set(Object.keys(LOC_NAMES));

function makePool(dbName) {
  return new Pool({
    host:                         process.env.DB_HOST     || 'localhost',
    port:                         parseInt(process.env.DB_PORT || '5432'),
    database:                     dbName,
    user:                         process.env.DB_USER     || process.env.USER,
    password:                     process.env.DB_PASSWORD || '',
    max:                          parseInt(process.env.DB_POOL_MAX || '20'),
    idleTimeoutMillis:            30000,
    connectionTimeoutMillis:      2000,
    keepAlive:                    true,
    keepAliveInitialDelayMillis:  10000,
  });
}

const pools = {
  kush: makePool(process.env.DB_NAME_KUSH || 'istok_kush'),
  kan:  makePool(process.env.DB_NAME_KAN  || 'istok_kan'),
};
Object.entries(pools).forEach(([loc, p]) =>
  p.on('error', err => console.error(`❌ [${loc}] PostgreSQL:`, err.message))
);

// ═══════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

app.use((req, res, next) => {
  // Сайт раздаёт сам сервер (тот же origin) — CORS нужен только для отдельного фронта при разработке
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN && (ALLOWED_ORIGIN === '*' || ALLOWED_ORIGIN.split(',').includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(compression({ filter: (req, res) => !req.path.endsWith('/events') && compression.filter(req, res) }));
// Тела запросов — до 50 КБ; только заявке на списание с фото — больше (её парсер стоит на маршруте)
const jsonSmall = express.json({ limit: '50kb' });
app.use((req, res, next) => (req.path.endsWith('/bb/writeoff') ? next() : jsonSmall(req, res, next)));

// ─── Сессии персонала (в памяти) ────────────────────────────────
// Сотрудник входит логином и паролем Флагмана и выбирает, где сейчас работает: ресторан и точку.
// Сессия помнит человека, его места работы и сессию склада (она в браузер не уходит) — по ней панель
// действует от его имени в точках других ресторанов. Разделы и методы открываются по роли в выбранном месте.
const SESSION_TTL = 10 * 60 * 60 * 1000; // 10 часов (смена)
const MAX_SESSIONS = 200;
const sessions = new Map();               // sid → { exp, person, workplaces, fm, tenantId, user }

function createSession(data) {
  if (sessions.size >= MAX_SESSIONS) {
    [...sessions.entries()].sort((a, b) => a[1].exp - b[1].exp).slice(0, 20).forEach(([k]) => dropSession(k));
  }
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { exp: Date.now() + SESSION_TTL, ...data });
  return sid;
}
/** Закрыть сессию панели — и сессию склада, которую она держала. */
function dropSession(sid) {
  const s = sessions.get(sid);
  sessions.delete(sid);
  if (s?.fm) flagman.logout(s.fm);
}
function sessionOf(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) { dropSession(sid); return null; }
  return s;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of sessions) if (now > v.exp) dropSession(k); }, 3_600_000);

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  return out;
}
/** Сотрудник, выбравший место работы (без выбора — ещё не в панели). */
const staffUser = req => sessionOf(req)?.user || null;
const isStaff = req => !!staffUser(req);
/** Сотрудник этой точки: кассир Истокграда не получает служебные данные Ясноречья, чужой ресторан — тем более. */
const isStaffAt = (req, loc) => !!staffUser(req)?.locs.includes(loc);

// ─── Ограничение частоты ─────────────────────────────────────────
const orderLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { ok: false, error: 'Слишком много запросов. Подождите минуту.' },
  standardHeaders: true, legacyHeaders: false,
});
// Панель персонала обновляется по живым событиям — её не ограничиваем
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, skip: isStaff, message: { ok: false, error: 'Слишком много запросов.' } });
app.use('/api/', apiLimiter);

// ─── Вход персонала ──────────────────────────────────────────────
// Логин и пароль — из Флагмана: админ заводит кассира там, и тот сразу входит сюда. Общий пароль ADMIN_TOKEN
// остаётся служебным входом владельца ИСТОК (без логина) — на случай, если склад недоступен.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

/**
 * Разделы панели → роли Флагмана (ТЗ 16): заказы пробивает только кассир, управляющему касса закрыта.
 * Служебный вход — все разделы.
 */
const ROLES = {
  kassir: ['CASHIER'],                                     // касса: зал, самовывоз, доставка, оплата
  orders: ['CASHIER', 'COOK', 'MANAGER', 'ADMIN'],         // заказы, кухня, курьер
  manage: ['MANAGER', 'ADMIN'],                            // бухгалтерия, выгрузки, очистка заказов
  any:    null,                                            // списание — любой сотрудник (по своему PIN)
};

function staff(req, res, next) {
  const s = sessionOf(req);
  if (!s?.user) return res.status(401).json({ error: 'Необходима авторизация. Войдите через /panel/login.html' });
  req.session = s;
  req.user = s.user;
  next();
}

/** После withLoc: работает ли сотрудник в этой точке и хватает ли роли для раздела. */
const allow = roles => (req, res, next) => {
  const u = req.user;
  if (!u.locs.includes(req.loc)) {
    const only = u.places.length === 1 ? `в точке «${u.places[0].name}»` : `в «${u.tenantName}»`;
    return res.status(403).json({ ok: false, error: `Вы сейчас работаете ${only} — смените место работы в панели` });
  }
  if (roles && !u.service && !roles.includes(u.role)) {
    return res.status(403).json({ ok: false, error: 'Этот раздел недоступен вашей роли' });
  }
  next();
};

/**
 * Место запроса: своя точка ИСТОК (каталог сайта, своя база, склад по ключу) или точка другого ресторана
 * (меню со склада, база в istok_ext, склад — сессией сотрудника). Чужую точку видит только тот, кто в ней работает.
 */
const OWN_MENU = {
  payload: (place, opts) => catalog.menuPayload(place.loc, opts),
  normalize: async (_place, items) => normalizeItems(items),
  stockLines: (place, items) => stockLines(place.loc, items),
  left: (place, lines) => catalog.leftAfterCart(place.loc, lines),
  refusal: (_place, details, lines, byDish) => catalog.refusalToSite(details, lines, byDish),
  async variantFor(place, b) {
    const item = catalog.BY_ID[String(b.itemId || '')];
    if (!item) return { error: 'Выберите блюдо или напиток' };
    const variantId = catalog.toVariant(catalog.variantsByDish(await flagman.menu(place.loc)), { id: item.id, size: b.size, variant: b.variant });
    return variantId ? { variantId } : { error: 'Этого блюда нет на складе' };
  },
};
const OWN = Object.fromEntries(Object.entries(LOC_NAMES).map(([loc, name]) => [loc,
  { loc, own: true, name, label: `ИСТОК ${name}`, pool: pools[loc], fm: flagman, menu: OWN_MENU }]));

async function withLoc(req, res, next) {
  const loc = req.params.loc;
  if (OWN[loc]) {
    req.loc = loc; req.place = OWN[loc]; req.pool = OWN[loc].pool;
    return next();
  }
  const s = sessionOf(req);
  const u = s?.user;
  if (!u || u.own || !u.locs.includes(loc)) {
    // Своя точка, но сейчас выбрано другое место работы — подскажем; чужую точку не выдаём даже названием
    const mine = u && s.workplaces.some(w => w.locations.some(l => l.id === loc));
    return mine
      ? res.status(403).json({ ok: false, error: `Сейчас вы работаете в «${u.tenantName}» — смените место работы в панели` })
      : res.status(404).json({ ok: false, error: 'Неизвестная точка — войдите в панель и выберите место работы' });
  }
  let pool;
  try {
    pool = await extdb.pool(loc);
  } catch (e) {
    console.error(`❌ [${loc}] база заказов:`, e.message);
    return res.status(503).json({ ok: false, error: 'База заказов недоступна' });
  }
  const name = u.places.find(p => p.id === loc)?.name || loc;
  req.loc = loc;
  req.pool = pool;
  req.place = { loc, own: false, name, label: `${u.tenantName} ${name}`, pool, fm: flagman.as(s.fm), menu: flagmenu, sid: parseCookies(req).sid };
  next();
}

/**
 * Ошибка склада в точке другого ресторана: сессия склада кончилась — закрываем и сессию панели (войти заново),
 * нет прав у роли — 403 с объяснением склада.
 */
function fmFail(req, res, e, prefix = 'Склад') {
  if (e?.expired) {
    if (req.place?.sid) dropSession(req.place.sid);
    return res.status(401).json({ ok: false, error: 'Вход в склад истёк — войдите в панель заново' });
  }
  if (e?.status === 0) return res.status(503).json({ ok: false, error: 'Склад недоступен' });
  if (e?.status === 403) return res.status(403).json({ ok: false, error: `${prefix}: ${e.message}` });
  return res.status(502).json({ ok: false, error: `${prefix}: ${e?.message || 'ошибка'}` });
}

// ─── Утилиты ─────────────────────────────────────────────────────
function sanitize(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>;"'\\]/g, '').trim().slice(0, maxLen);
}

const STATUS = {
  NEW: 'Новый', ACCEPTED: 'Принят', COOKING: 'Готовится', READY: 'Готов к выдаче',
  ON_WAY: 'В пути', DONE: 'Выполнен', CANCELLED: 'Отменён',
};
const VALID_STATUSES = new Set(Object.values(STATUS));
const FLOW = [STATUS.NEW, STATUS.ACCEPTED, STATUS.COOKING, STATUS.READY, STATUS.ON_WAY, STATUS.DONE];
const TO_FLAGMAN = {
  [STATUS.ACCEPTED]: 'ACCEPTED', [STATUS.COOKING]: 'COOKING', [STATUS.READY]: 'READY',
  [STATUS.ON_WAY]: 'DELIVERING', [STATUS.DONE]: 'DONE',
};
const FROM_FLAGMAN = {
  NEW: STATUS.NEW, ACCEPTED: STATUS.ACCEPTED, COOKING: STATUS.COOKING, READY: STATUS.READY,
  DELIVERING: STATUS.ON_WAY, DONE: STATUS.DONE, CANCELED: STATUS.CANCELLED, CANCELED_LATE: STATUS.CANCELLED,
};
const DELIVERY = { fee: 150, freeFrom: 1000 };

// ═══════════════════════════════════════════════════════════════════
//  ЗАКАЗЫ: проверка и списание — во «Флагмане», «всё или ничего»
// ═══════════════════════════════════════════════════════════════════

/** Позиции корзины: цена — по каталогу сайта, а не из браузера (защита от подмены цены). */
function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) return { error: 'Корзина пуста' };
  if (items.length > 50) return { error: 'Слишком много позиций в заказе' };
  const out = [];
  for (const i of items) {
    const item = catalog.BY_ID[String(i?.id || '')];
    if (!item) return { error: 'В заказе есть блюдо, которого нет в меню' };
    const qty = parseInt(i.qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > 99) return { error: 'Некорректное количество товара' };
    const size = Number(i.size) === 1 ? 1 : 0;
    const variant = Math.max(0, parseInt(i.variant) || 0);
    out.push({ id: item.id, name: sanitize(String(i.name || item.name), 100) || item.name, price: catalog.price(item, size), qty, size, variant });
  }
  return { items: out };
}

/** Строки для склада: позиции сайта → варианты Флагмана, одинаковые — складываем. */
async function stockLines(loc, items) {
  const byDish = catalog.variantsByDish(await flagman.menu(loc));
  const lines = items.map(i => ({ ...i, variantId: catalog.toVariant(byDish, i) }));
  const agg = {};
  for (const l of lines) if (l.variantId) agg[l.variantId] = (agg[l.variantId] || 0) + l.qty;
  return { byDish, lines, stock: Object.entries(agg).map(([variantId, qty]) => ({ variantId, qty })) };
}

/**
 * Единая точка создания заказа (сайт, касса, эмулятор).
 * 409 — склад отказал: гость видит, чего не хватает, «максимум N» и похожие блюда.
 * Склад недоступен — заказ ИСТОК принимаем и досылаем позже (stock_sync = pending); в точке другого ресторана
 * досылать некому (склад — от имени сотрудника), поэтому такой заказ не принимаем.
 */
async function placeOrder(place, o) {
  const { loc } = place;
  const norm = await place.menu.normalize(place, o.items);
  if (norm.error) return { status: 400, body: { ok: false, error: norm.error } };
  const items = norm.items;
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const deliveryCost = o.type === 'delivery' && total < DELIVERY.freeFrom ? DELIVERY.fee : 0;
  const prefix = { kassir: 'CASH', simulator: 'SIM' }[o.source] || 'SITE';
  const externalId = `${prefix}-${loc}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  let flagmanId = null, sync = 'ok', note = null, linesForStock = null;
  try {
    const s = await place.menu.stockLines(place, items);
    linesForStock = s.stock;
    const created = await place.fm.createOrder(loc, { externalId, source: o.source === 'kassir' ? 'POS' : 'SITE', lines: s.stock });
    flagmanId = created.id;
  } catch (e) {
    if (e instanceof flagman.FlagmanError && e.status === 409 && e.details) {
      const s = await place.menu.stockLines(place, items);
      events.emit(loc, 'order.refused', { reason: e.details.message });
      return { status: 409, body: place.menu.refusal(place, e.details, s.lines, s.byDish) };
    }
    if (!place.own && e instanceof flagman.FlagmanError) throw e;   // ответит маршрут (fmFail)
    if (e instanceof flagman.FlagmanError && e.status === 0) {
      sync = 'pending';
      note = 'Склад был недоступен — продукты спишутся, когда связь восстановится';
      console.warn(`[${loc}] склад недоступен, заказ принят без проверки: ${e.message}`);
    } else {
      console.error(`[${loc}] склад отклонил заказ:`, e.message);
      return { status: 502, body: { ok: false, error: `Склад не принял заказ: ${e.message}` } };
    }
  }

  const { rows: [order] } = await place.pool.query(
    `INSERT INTO bb_orders (iiko_id, customer, phone, address, type, comment, items, total_items, delivery_cost, grand_total,
                            status, payment, source, flagman_order_id, stock_sync, stock_note, stock_lines)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, order_number`,
    [externalId, o.customer, o.phone, o.type === 'delivery' ? o.address : (o.address || 'Самовывоз'), o.type, o.comment,
     JSON.stringify(items), total, deliveryCost, total + deliveryCost, STATUS.NEW, o.payment === 'card' ? 'card' : 'cash',
     o.source, flagmanId, sync, note, linesForStock ? JSON.stringify(linesForStock) : null]);

  events.emit(loc, 'order.created', { id: order.id, order_number: order.order_number, type: o.type, source: o.source });
  // Точкам ИСТОК об изменении склада сообщает сам Флагман (ретрансляция); остальным — сразу отсюда
  if (!place.own) events.emit(loc, 'stock.changed', { reasons: ['order.created'] });
  if (place.own && process.env.AUTO_FLOW !== 'false') autoFlow(place, order.id);
  exportOrdersBackground(place);
  return {
    status: 200,
    body: {
      ok: true, orderNumber: order.order_number, orderId: order.id, iikoId: externalId,
      total, deliveryCost, grandTotal: total + deliveryCost, stock: sync,
      message: `Заказ #${order.order_number} принят! Позвоним в течение 5 минут.`,
    },
  };
}

/** Демо ИСТОК: заказ сам проходит «Принят» → «Готовится», как раньше; статус уходит и на склад. */
function autoFlow(place, id) {
  [[6000, STATUS.ACCEPTED], [20000, STATUS.COOKING]].forEach(([delay, status]) => setTimeout(async () => {
    try {
      const { rows } = await place.pool.query('SELECT status FROM bb_orders WHERE id=$1', [id]);
      if (rows[0] && FLOW.indexOf(rows[0].status) >= 0 && FLOW.indexOf(rows[0].status) < FLOW.indexOf(status)) {
        await changeStatus(place, id, status);
      }
    } catch (e) { console.error('autoFlow:', e.message); }
  }, delay));
}

/**
 * Смена статуса. Отмена — сначала на складе (вернуть продукты или записать в потери), потом у себя.
 * Остальные статусы у ИСТОК — у себя, на склад best-effort (статус склада меняется только вперёд).
 * В точке другого ресторана склад проверяет роль сотрудника — поэтому сначала он, потом у себя.
 */
async function changeStatus(place, id, status, { reason } = {}) {
  const { loc, pool: p } = place;
  const { rows: [o] } = await p.query('SELECT id, status, flagman_order_id, stock_sync FROM bb_orders WHERE id=$1', [id]);
  if (!o) return { status: 404, body: { error: 'Не найден' } };
  if (o.status === status) return { status: 200, body: { ok: true, status } };
  let note = null;
  if (status === STATUS.CANCELLED) {
    if (o.flagman_order_id) {
      try {
        const r = await place.fm.cancelOrder(loc, o.flagman_order_id, reason || 'Отмена из панели ресторана');
        note = r?.status === 'CANCELED_LATE' ? 'Отменён после начала готовки — себестоимость ушла в потери' : 'Продукты вернулись на склад';
      } catch (e) {
        if (e.expired || (!place.own && e.status === 403)) throw e;
        if (e.status === 0) return { status: 503, body: { error: 'Склад недоступен — отмену нельзя провести, попробуйте ещё раз' } };
        if (e.status !== 409) return { status: 502, body: { error: `Склад: ${e.message}` } };
      }
    }
  } else if (o.flagman_order_id && TO_FLAGMAN[status]) {
    const sent = place.fm.setOrderStatus(loc, o.flagman_order_id, TO_FLAGMAN[status]);
    if (place.own) {
      sent.catch(e => {
        if (e.status !== 409) console.warn(`[${loc}] статус на склад не ушёл (${o.flagman_order_id} → ${status}): ${e.message}`);
      });
    } else {
      try { await sent; } catch (e) {
        if (e.expired || e.status === 403) throw e;
        if (e.status === 0) return { status: 503, body: { error: 'Склад недоступен — попробуйте ещё раз' } };
        if (e.status !== 409) return { status: 502, body: { error: `Склад: ${e.message}` } };
      }
    }
  }
  const { rows } = await p.query(
    `UPDATE bb_orders SET status=$1::varchar, updated_at=NOW(), stock_note=COALESCE($2::text, stock_note),
            stock_sync = CASE WHEN $1::varchar = 'Отменён' AND stock_sync = 'pending' THEN 'off' ELSE stock_sync END
     WHERE id=$3 RETURNING order_number, status`, [status, note, id]);
  events.emit(loc, 'order.updated', { id, status, order_number: rows[0].order_number });
  if (!place.own && status === STATUS.CANCELLED) events.emit(loc, 'stock.changed', { reasons: ['order.canceled'] });
  return { status: 200, body: { ok: true, status: rows[0].status, note } };
}

/** Повар отметил «готово» на кухне Флагмана — подтягиваем статусы к себе (только вперёд). */
async function reconcile(place) {
  const list = await place.fm.orders(place.loc, 100);
  const byId = Object.fromEntries(list.map(x => [x.id, x]));
  const { rows } = await place.pool.query(
    `SELECT id, status, flagman_order_id FROM bb_orders
     WHERE flagman_order_id IS NOT NULL AND status NOT IN ('Выполнен','Отменён') AND created_at > NOW() - INTERVAL '2 days'`);
  for (const r of rows) {
    const f = byId[r.flagman_order_id];
    const next = f && FROM_FLAGMAN[f.status];
    if (!next || next === r.status) continue;
    const ahead = next === STATUS.CANCELLED || FLOW.indexOf(next) > FLOW.indexOf(r.status);
    if (!ahead) continue;
    await place.pool.query('UPDATE bb_orders SET status=$1, updated_at=NOW() WHERE id=$2', [next, r.id]);
    events.emit(place.loc, 'order.updated', { id: r.id, status: next, from: 'flagman' });
  }
}
/** Для точек ИСТОК — по событию склада, с небольшой задержкой (события приходят пачкой). */
const reconcileTimers = {};
function reconcileOrders(loc) {
  clearTimeout(reconcileTimers[loc]);
  reconcileTimers[loc] = setTimeout(() => reconcile(OWN[loc])
    .catch(e => { if (e.status !== 0) console.warn(`[${loc}] сверка заказов:`, e.message); }), 400);
}

/** Заказы ИСТОК, принятые без склада, досылаем, когда склад снова доступен (повтор безопасен: тот же externalId). */
async function retryPending() {
  for (const place of Object.values(OWN)) {
    const { loc, pool } = place;
    let rows;
    try {
      ({ rows } = await pool.query(
        `SELECT id, iiko_id, items, source FROM bb_orders WHERE stock_sync='pending' AND created_at > NOW() - INTERVAL '1 day' ORDER BY id LIMIT 20`));
    } catch { continue; }
    for (const r of rows) {
      try {
        const items = typeof r.items === 'string' ? JSON.parse(r.items) : r.items;
        const s = await stockLines(loc, items);
        const created = await flagman.createOrder(loc, { externalId: r.iiko_id, source: r.source === 'kassir' ? 'POS' : 'SITE', lines: s.stock });
        await pool.query(`UPDATE bb_orders SET flagman_order_id=$1, stock_sync='ok', stock_note=NULL, stock_lines=$2, updated_at=NOW() WHERE id=$3`,
          [created.id, JSON.stringify(s.stock), r.id]);
        events.emit(loc, 'order.updated', { id: r.id, stock: 'ok' });
        console.log(`[${loc}] заказ ${r.iiko_id} досписан на складе`);
      } catch (e) {
        if (e.status === 0) return;   // склад всё ещё недоступен — попробуем позже
        const msg = e.status === 409 ? `Склад отказал: ${e.details?.message || e.message}` : e.message;
        await pool.query(`UPDATE bb_orders SET stock_sync='failed', stock_note=$1, updated_at=NOW() WHERE id=$2`, [msg, r.id]);
        events.emit(loc, 'order.updated', { id: r.id, stock: 'failed' });
        console.warn(`[${loc}] заказ ${r.iiko_id}: ${msg}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  МАРШРУТЫ — ОБЩИЕ
// ═══════════════════════════════════════════════════════════════════
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 10,
  message: { ok: false, error: 'Слишком много попыток. Подождите 5 минут.' },
});

/** Места работы — в браузер: рестораны, роль и точки (точки ИСТОК — с названиями сайта). */
const publicWorkplaces = list => list.map(w => ({ tenantName: w.tenantName, role: w.role, own: w.own, locations: w.locations }));
const publicUser = u => ({
  login: u.login, name: u.name, role: u.role, service: !!u.service, tenantName: u.tenantName, own: u.own,
  loc: u.loc, places: u.places, multi: u.multi,
});

/** Служебный вход владельца ИСТОК — только точки ИСТОК, со всеми разделами. */
const ISTOK_WORKPLACE = {
  tenantId: null, tenantName: 'ИСТОК', role: 'ADMIN', own: true,
  locations: Object.entries(LOC_NAMES).map(([id, name]) => ({ id, name })),
};

/** Сотрудник выбрал место работы: сессия склада переходит в его предприятие, роль — оттуда. */
async function enterWorkplace(s, loc) {
  const w = s.workplaces.find(x => x.locations.some(l => l.id === loc));
  if (!w) throw Object.assign(new Error('Вы не работаете в этой точке'), { status: 403 });
  let role = w.role;
  if (s.fm && s.tenantId !== w.tenantId) {
    const me = await flagman.switchTenant(s.fm, w.tenantId);
    s.tenantId = me.tenantId;
    role = me.role;
  }
  s.user = {
    ...s.person, role, tenantName: w.tenantName, own: w.own, loc,
    locs: w.locations.map(l => l.id), places: w.locations,
    multi: s.workplaces.reduce((n, x) => n + x.locations.length, 0) > 1,
  };
  return s.user;
}

const loginError = e => {
  if (e.status === 0) return [503, 'Склад недоступен — войдите позже или служебным паролем'];
  if (e.status === 401) return [401, e.expired ? 'Вход в склад истёк — войдите заново' : 'Неверный логин или пароль'];
  if (e.status === 403 || e.status === 429) return [e.status, e.message];
  return [502, e.message];
};

app.post('/api/login', loginLimiter, async (req, res) => {
  const { login, password } = req.body || {};
  const name = String(login || '').trim();
  if (!password) return res.status(400).json({ ok: false, error: 'Введите пароль' });
  const data = { person: null, workplaces: [], fm: null, tenantId: null, user: null };
  if (!name) {
    // Служебный вход владельца — общий пароль из .env, без логина
    if (!ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'Введите логин и пароль' });
    const pwdBuf = Buffer.from(String(password));
    const tokBuf = Buffer.from(ADMIN_TOKEN);
    if (pwdBuf.length !== tokBuf.length || !crypto.timingSafeEqual(pwdBuf, tokBuf)) {
      return res.status(401).json({ ok: false, error: 'Неверный пароль' });
    }
    data.person = { login: 'service', name: 'Служебный вход', service: true };
    data.workplaces = [ISTOK_WORKPLACE];
  } else {
    if (!flagman.configured()) return res.status(503).json({ ok: false, error: 'Склад не подключён — вход по логину недоступен' });
    try {
      // Склад проверяет пароль и говорит, где человек работает: рестораны, роль в каждом и точки
      const { me, cookie } = await flagman.staffLogin(name, String(password));
      data.fm = cookie;
      data.tenantId = me.tenantId;
      data.person = { login: me.login, name: me.name, service: false };
      data.workplaces = (await flagman.workplaces(cookie)).filter(w => w.locations.length).map(w => {
        const own = w.locations.some(l => OWN[l.id]);
        return { tenantId: w.tenantId, tenantName: own ? 'ИСТОК' : w.tenantName, role: w.role, own,
          locations: w.locations.map(l => ({ id: l.id, name: OWN[l.id] ? LOC_NAMES[l.id] : l.name })) };
      });
    } catch (e) {
      flagman.logout(data.fm);
      const [status, error] = loginError(e);
      return res.status(status).json({ ok: false, error });
    }
    if (!data.workplaces.length) {
      flagman.logout(data.fm);
      return res.status(403).json({ ok: false, error: 'Вы пока не работаете ни в одном ресторане — попросите админа пригласить вас во «Флагмане»' });
    }
  }
  const sid = createSession(data);
  const s = sessions.get(sid);
  // Одно место работы — сразу в него; несколько — человек выбирает
  const places = s.workplaces.flatMap(w => w.locations);
  if (places.length === 1) {
    try { await enterWorkplace(s, places[0].id); } catch (e) {
      dropSession(sid);
      const [status, error] = loginError(e);
      return res.status(status).json({ ok: false, error });
    }
  }
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'strict', maxAge: SESSION_TTL, path: '/' });
  res.json({ ok: true, user: s.user && publicUser(s.user), person: s.person, workplaces: publicWorkplaces(s.workplaces) });
});

// Выбрать место работы (после входа или сменить): ресторан и точку
app.post('/api/workplace', async (req, res) => {
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ ok: false, error: 'Войдите в панель' });
  try {
    res.json({ ok: true, user: publicUser(await enterWorkplace(s, String(req.body?.loc || ''))) });
  } catch (e) {
    if (e.expired) dropSession(parseCookies(req).sid);
    const [status, error] = e instanceof flagman.FlagmanError ? loginError(e) : [e.status || 500, e.message];
    res.status(status).json({ ok: false, error });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) dropSession(sid);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

// Кто вошёл; вошёл, но место работы ещё не выбрал — ok: false, зато есть person и workplaces
app.get('/api/auth-check', (req, res) => {
  const s = sessionOf(req);
  res.json({ ok: !!s?.user, user: s?.user ? publicUser(s.user) : null,
    person: s?.person || null, workplaces: s ? publicWorkplaces(s.workplaces) : [] });
});
app.get('/api/ping', (_req, res) => res.json({ ok: true, stock: flagman.configured() ? 'flagman' : 'off' }));
app.get('/api/locations', (_req, res) => res.json(LOC_NAMES));

// ═══════════════════════════════════════════════════════════════════
//  МАРШРУТЫ — ТОЧКА :loc
// ═══════════════════════════════════════════════════════════════════

// GET /api/:loc/bb/menu — меню с наличием со склада (публичный)
app.get('/api/:loc/bb/menu', withLoc, async (req, res) => {
  if (!req.place.own) {
    // Точка другого ресторана: меню — со склада (его видит только сотрудник этой точки)
    try { return res.json(await flagmenu.payload(req.place, { staff: true })); } catch (e) { return fmFail(req, res, e); }
  }
  try {
    res.json(await catalog.menuPayload(req.loc, { staff: isStaffAt(req, req.loc) }));
  } catch (e) {
    // Склад недоступен — сайт продолжает работать по каталогу, без отметок о наличии
    console.warn(`[${req.loc}] меню без склада: ${e.message}`);
    res.json({ categories: catalog.CATEGORIES, items: catalog.ITEMS.map(i => ({ ...i, available: true, stop_reason: null, portions_left: null, hot: null })),
      updated_at: new Date().toISOString(), stock_offline: true });
  }
});

// POST /api/:loc/bb/menu/left — сколько ещё можно пробить после корзины кассы (только персоналу)
app.post('/api/:loc/bb/menu/left', staff, withLoc, allow(ROLES.kassir), async (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 100) : [];
  try {
    res.json({ ok: true, left: await req.place.menu.left(req.place, lines) });
  } catch (e) {
    if (!req.place.own) return fmFail(req, res, e);
    res.status(502).json({ ok: false, error: `Склад недоступен: ${e.message}` });
  }
});

// GET /api/:loc/bb/events — живые обновления (гостю — склад и стоп-лист, персоналу — всё)
app.get('/api/:loc/bb/events', withLoc, (req, res) => events.attach(req.loc, req, res, isStaffAt(req, req.loc)));

// POST /api/:loc/bb/order — заказ с сайта или доставка из кассы (публичный)
app.post('/api/:loc/bb/order', orderLimiter, withLoc, async (req, res) => {
  const b = req.body || {};
  const type = b.type === 'delivery' ? 'delivery' : b.type === 'pickup' ? 'pickup' : null;
  const customer = sanitize(b.customer || '', 60);
  const phone = sanitize(b.phone || '', 24);
  const address = sanitize(b.address || '', 140);
  if (!type) return res.status(400).json({ ok: false, error: 'Неверный тип заказа' });
  if (customer.length < 2) return res.status(400).json({ ok: false, error: 'Укажите имя (минимум 2 символа)' });
  if (phone.replace(/\D/g, '').length < 11) return res.status(400).json({ ok: false, error: 'Укажите полный номер телефона' });
  if (type === 'delivery' && address.length < 5) return res.status(400).json({ ok: false, error: 'Укажите адрес доставки' });
  const source = b.source === 'kassir' && isStaffAt(req, req.loc) ? 'kassir' : 'site';
  try {
    const r = await placeOrder(req.place, { customer, phone, address, type, comment: sanitize(b.comment || '', 300), items: b.items, payment: b.payment, source });
    res.status(r.status).json(r.body);
  } catch (err) {
    if (err instanceof flagman.FlagmanError) return fmFail(req, res, err, 'Склад не принял заказ');
    console.error(`❌ [${req.loc}] заказ:`, err.message);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// POST /api/:loc/bb/cashier — заказ из кассы: зал, веранда, самовывоз
app.post('/api/:loc/bb/cashier', staff, withLoc, allow(ROLES.kassir), async (req, res) => {
  const { table, comment, payment, items } = req.body || {};
  const payLabel = payment === 'card' ? 'Карта' : 'Наличные';
  const parts = String(comment || '').split('\n');
  const autoLine = sanitize(parts[0] || '', 200);
  const extraLine = sanitize(parts[1] || '', 200);
  try {
    const r = await placeOrder(req.place, {
      customer: sanitize(table || 'Гость', 50) || 'Гость', phone: '—', address: 'Зал', type: 'pickup',
      comment: extraLine ? `${payLabel} | ${autoLine}\n${extraLine}` : `${payLabel} | ${autoLine}`,
      items, payment, source: 'kassir',
    });
    res.status(r.status).json(r.body);
  } catch (err) {
    if (err instanceof flagman.FlagmanError) return fmFail(req, res, err, 'Склад не принял заказ');
    console.error(`❌ [${req.loc}] касса:`, err.message);
    res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

// POST /api/:loc/bb/confirm/:num — клиент подтвердил получение (публичный)
app.post('/api/:loc/bb/confirm/:num', orderLimiter, withLoc, async (req, res) => {
  const num = parseInt(req.params.num);
  if (!num || num <= 0) return res.status(400).json({ error: 'Неверный номер заказа' });
  try {
    const { rows } = await req.pool.query(`SELECT id, status FROM bb_orders WHERE order_number=$1`, [num]);
    if (!rows.length) return res.status(404).json({ error: 'Не найден' });
    if (rows[0].status === STATUS.CANCELLED) return res.status(409).json({ error: 'Заказ отменён' });
    const r = await changeStatus(req.place, rows[0].id, STATUS.DONE);
    await req.pool.query('UPDATE bb_orders SET confirmed_by_client=TRUE WHERE id=$1', [rows[0].id]);
    res.status(r.status).json({ ok: true, orderNumber: num });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

// GET /api/:loc/bb/track/:num — трекинг заказа (публичный)
app.get('/api/:loc/bb/track/:num', orderLimiter, withLoc, async (req, res) => {
  const num = parseInt(req.params.num);
  if (!num || num <= 0) return res.status(400).json({ error: 'Неверный номер заказа' });
  try {
    const { rows } = await req.pool.query(
      `SELECT order_number, status, type, customer, grand_total, confirmed_by_client, created_at, updated_at,
              to_char(created_at AT TIME ZONE 'Europe/Moscow','HH24:MI') AS time
       FROM bb_orders WHERE order_number=$1`, [num]);
    if (!rows.length) return res.status(404).json({ error: 'Не найден' });
    res.json({ ok: true, ...rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

// GET /api/:loc/bb/orders — заказы для панели
app.get('/api/:loc/bb/orders', staff, withLoc, allow(ROLES.orders), async (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit)  || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  try {
    // Точке другого ресторана склад событий не шлёт: статусы с кухни Флагмана подтягиваем при просмотре
    if (!req.place.own) await reconcile(req.place).catch(e => { if (e.status !== 0) console.warn(`[${req.loc}] сверка заказов:`, e.message); });
    const { rows } = await req.pool.query('SELECT * FROM bb_orders_view LIMIT $1 OFFSET $2', [limit, offset]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

// PATCH /api/:loc/bb/orders/:id/status — сменить статус (касса, кухня, курьер)
app.patch('/api/:loc/bb/orders/:id/status', staff, withLoc, allow(ROLES.orders), async (req, res) => {
  const { status, reason } = req.body || {};
  if (!status || !VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Недопустимый статус' });
  try {
    const r = await changeStatus(req.place, parseInt(req.params.id), status, { reason: sanitize(reason || '', 200) || undefined });
    res.status(r.status).json(r.body);
  } catch (err) {
    if (err instanceof flagman.FlagmanError) return fmFail(req, res, err);
    console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/:loc/bb/stats — статистика для панели
app.get('/api/:loc/bb/stats', staff, withLoc, allow(ROLES.orders), async (req, res) => {
  try {
    const { rows } = await req.pool.query(`
      SELECT COUNT(*) FILTER (WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow') = DATE(NOW() AT TIME ZONE 'Europe/Moscow')) AS total,
        COUNT(*) FILTER (WHERE status='Новый')        AS new_orders,
        COUNT(*) FILTER (WHERE status IN ('Новый','Принят','Готовится')) AS cooking,
        COUNT(*) FILTER (WHERE status='В пути')       AS on_way,
        COUNT(*) FILTER (WHERE status='Выполнен' AND DATE(created_at AT TIME ZONE 'Europe/Moscow') = DATE(NOW() AT TIME ZONE 'Europe/Moscow')) AS done,
        COUNT(*) FILTER (WHERE stock_sync IN ('pending','failed')) AS stock_issues,
        COALESCE(SUM(grand_total) FILTER (WHERE status!='Отменён'),0) AS revenue,
        COALESCE(SUM(grand_total) FILTER (WHERE status!='Отменён'
          AND DATE(created_at AT TIME ZONE 'Europe/Moscow') = DATE(NOW() AT TIME ZONE 'Europe/Moscow')),0) AS revenue_today
      FROM bb_orders`);
    const r = rows[0];
    res.json(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

// POST /api/:loc/bb/fix-statuses — зависшие «Новый/Принят» старше 3 ч → «Готовится»
app.post('/api/:loc/bb/fix-statuses', staff, withLoc, allow(ROLES.orders), async (req, res) => {
  try {
    const { rows } = await req.pool.query(
      `SELECT id FROM bb_orders WHERE status IN ('Новый','Принят') AND created_at < NOW() - INTERVAL '3 hours'`);
    for (const r of rows) await changeStatus(req.place, r.id, STATUS.COOKING);
    res.json({ ok: true, fixed: rows.length });
  } catch (err) {
    if (err instanceof flagman.FlagmanError) return fmFail(req, res, err);
    console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ─── Бухгалтерия ─────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateDates(from, to) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return 'Неверный формат даты (YYYY-MM-DD)';
  if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) return 'Неверная дата';
  if (from > to) return 'Дата начала не может быть позже даты конца';
  return null;
}
function period(req) {
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const to   = req.query.to   || new Date().toISOString().slice(0, 10);
  return { from, to, err: validateDates(from, to) };
}

app.get('/api/:loc/bb/accounting/summary', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  const { from, to, err } = period(req);
  if (err) return res.status(400).json({ error: err });
  try {
    const { rows } = await req.pool.query(`
      SELECT COUNT(*) AS total_orders,
        COUNT(*) FILTER (WHERE status!='Отменён') AS completed,
        COUNT(*) FILTER (WHERE status ='Отменён') AS cancelled,
        COUNT(*) FILTER (WHERE type='delivery' AND status!='Отменён') AS deliveries,
        COUNT(*) FILTER (WHERE type='pickup'   AND status!='Отменён') AS pickups,
        COALESCE(SUM(grand_total)   FILTER (WHERE status!='Отменён'),0) AS revenue,
        COALESCE(SUM(delivery_cost) FILTER (WHERE status!='Отменён'),0) AS delivery_fees,
        COALESCE(AVG(grand_total)   FILTER (WHERE status!='Отменён'),0) AS avg_order
      FROM bb_orders WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow') BETWEEN $1 AND $2`, [from, to]);
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

app.get('/api/:loc/bb/accounting/daily', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  const { from, to, err } = period(req);
  if (err) return res.status(400).json({ error: err });
  try {
    const { rows } = await req.pool.query(`
      SELECT to_char(DATE(created_at AT TIME ZONE 'Europe/Moscow'),'DD.MM.YYYY') AS date,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status!='Отменён') AS completed,
        COUNT(*) FILTER (WHERE type='delivery' AND status!='Отменён') AS deliveries,
        COUNT(*) FILTER (WHERE type='pickup'   AND status!='Отменён') AS pickups,
        COALESCE(SUM(grand_total)   FILTER (WHERE status!='Отменён'),0) AS revenue,
        COALESCE(SUM(delivery_cost) FILTER (WHERE status!='Отменён'),0) AS delivery_fees
      FROM bb_orders WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow') BETWEEN $1 AND $2
      GROUP BY DATE(created_at AT TIME ZONE 'Europe/Moscow')
      ORDER BY DATE(created_at AT TIME ZONE 'Europe/Moscow') DESC`, [from, to]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

app.get('/api/:loc/bb/accounting/items', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  const { from, to, err } = period(req);
  if (err) return res.status(400).json({ error: err });
  try {
    const { rows } = await req.pool.query(`
      SELECT item->>'name' AS name,
        SUM((item->>'qty')::int) AS quantity,
        SUM((item->>'price')::numeric*(item->>'qty')::int) AS revenue
      FROM bb_orders, jsonb_array_elements(items) AS item
      WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow') BETWEEN $1 AND $2 AND status!='Отменён'
      GROUP BY item->>'name' ORDER BY revenue DESC`, [from, to]);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

app.get('/api/:loc/bb/accounting/excel', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  const { from, to, err } = period(req);
  if (err) return res.status(400).json({ error: err });
  const p = req.pool;
  try {
    const { rows: lines } = await p.query(`
      SELECT to_char(o.created_at AT TIME ZONE 'Europe/Moscow','DD.MM.YYYY') AS "Дата",
        (item->>'name') AS "Наименование", '' AS "Вес",
        (item->>'qty')::int AS "Количество",
        (item->>'price')::int AS "Цена за порцию", (item->>'price')::int AS "Цена/Порция",
        (item->>'price')::int*(item->>'qty')::int AS "Сумма"
      FROM bb_orders o, jsonb_array_elements(o.items) AS item
      WHERE DATE(o.created_at AT TIME ZONE 'Europe/Moscow') BETWEEN $1 AND $2
        AND o.status!='Отменён' ORDER BY o.created_at, item->>'name'`, [from, to]);
    const { rows: daily } = await p.query(`
      SELECT to_char(DATE(created_at AT TIME ZONE 'Europe/Moscow'),'DD.MM.YYYY') AS "Дата",
        COUNT(*) AS "Всего заказов",
        COUNT(*) FILTER (WHERE status!='Отменён') AS "Выполнено",
        COUNT(*) FILTER (WHERE type='delivery' AND status!='Отменён') AS "Доставок",
        COUNT(*) FILTER (WHERE type='pickup'   AND status!='Отменён') AS "Самовывозов",
        COALESCE(SUM(grand_total)   FILTER (WHERE status!='Отменён'),0) AS "Выручка ₽",
        COALESCE(SUM(delivery_cost) FILTER (WHERE status!='Отменён'),0) AS "Из них доставка ₽"
      FROM bb_orders WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow') BETWEEN $1 AND $2
      GROUP BY DATE(created_at AT TIME ZONE 'Europe/Moscow')
      ORDER BY DATE(created_at AT TIME ZONE 'Europe/Moscow') DESC`, [from, to]);
    const { rows: byItem } = await p.query(`
      SELECT item->>'name' AS "Блюдо",
        SUM((item->>'qty')::int) AS "Продано (шт.)",
        (item->>'price')::int AS "Цена за порцию",
        SUM((item->>'price')::int*(item->>'qty')::int) AS "Выручка ₽"
      FROM bb_orders, jsonb_array_elements(items) AS item
      WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow') BETWEEN $1 AND $2 AND status!='Отменён'
      GROUP BY item->>'name',(item->>'price')::int ORDER BY 4 DESC`, [from, to]);
    const { rows: summary } = await p.query(`
      SELECT COUNT(*) AS "Всего заказов",
        COUNT(*) FILTER (WHERE status!='Отменён') AS "Выполнено",
        COUNT(*) FILTER (WHERE status ='Отменён') AS "Отменено",
        COALESCE(SUM(grand_total)    FILTER (WHERE status!='Отменён'),0) AS "Общая выручка ₽",
        COALESCE(SUM(delivery_cost)  FILTER (WHERE status!='Отменён'),0) AS "Выручка с доставок ₽",
        COALESCE(ROUND(AVG(grand_total) FILTER (WHERE status!='Отменён')),0) AS "Средний чек ₽"
      FROM bb_orders WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow') BETWEEN $1 AND $2`, [from, to]);

    const wb = XLSX.utils.book_new();
    const sl = XLSX.utils.json_to_sheet(lines);
    const sd = XLSX.utils.json_to_sheet(daily);
    const sb = XLSX.utils.json_to_sheet(byItem);
    const ss = XLSX.utils.json_to_sheet(summary);
    sl['!cols'] = [{wch:12},{wch:40},{wch:8},{wch:12},{wch:16},{wch:14},{wch:12}];
    sd['!cols'] = [{wch:12},{wch:14},{wch:12},{wch:10},{wch:14},{wch:14},{wch:18}];
    sb['!cols'] = [{wch:40},{wch:14},{wch:16},{wch:14}];
    XLSX.utils.book_append_sheet(wb, sl, 'Продажи по блюдам');
    XLSX.utils.book_append_sheet(wb, sd, 'По дням');
    XLSX.utils.book_append_sheet(wb, sb, 'Сводка по блюдам');
    XLSX.utils.book_append_sheet(wb, ss, 'Итоги');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = `Отчёт ${req.place.label} ${from} — ${to}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

// ─── Удаление заказов (только у себя: журнал склада неизменяем) ───
app.delete('/api/:loc/bb/orders/clear-active', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  try {
    const { rowCount } = await req.pool.query(`DELETE FROM bb_orders WHERE status NOT IN ('Выполнен','Отменён')`);
    events.emit(req.loc, 'order.updated', {});
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});
app.delete('/api/:loc/bb/orders/clear-done', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  try {
    const { rowCount } = await req.pool.query(`DELETE FROM bb_orders WHERE status IN ('Выполнен','Отменён')`);
    events.emit(req.loc, 'order.updated', {});
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});
app.delete('/api/:loc/bb/orders/all', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  try {
    const { rowCount } = await req.pool.query('DELETE FROM bb_orders');
    await req.pool.query("SELECT setval('bb_order_number_seq',1001,false)");
    events.emit(req.loc, 'order.updated', {});
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

// ═══════════════════════════════════════════════════════════════════
//  ЭКСПОРТ ЗАКАЗОВ В ФАЙЛЫ (по точкам)
// ═══════════════════════════════════════════════════════════════════
const ORDERS_DIR = path.join(__dirname, 'orders');

function dateLabel(d) {
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getFullYear()).slice(2)}`;
}

function exportOrdersBackground(place) {
  exportOrders(new Date(), place).catch(err => console.error(`[${place.loc}] Фоновый экспорт не удался:`, err.message));
}

async function exportOrders(date, place) {
  const { loc, pool: p } = place;
  const label   = dateLabel(date);
  const msk     = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const dateStr = `${msk.getFullYear()}-${String(msk.getMonth()+1).padStart(2,'0')}-${String(msk.getDate()).padStart(2,'0')}`;
  const dirPath = path.join(ORDERS_DIR, loc, label);
  const { rows } = await p.query(
    `SELECT order_number,customer,phone,address,type,comment,items,total_items,delivery_cost,grand_total,status,
            to_char(created_at AT TIME ZONE 'Europe/Moscow','DD.MM.YYYY HH24:MI') AS time
     FROM bb_orders WHERE DATE(created_at AT TIME ZONE 'Europe/Moscow')=$1 ORDER BY created_at`, [dateStr]);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, 'orders.json'), JSON.stringify({ date: label, loc, total: rows.length, orders: rows }, null, 2), 'utf8');
  const lines = ['════════════════════════════════', `  ${place.label}`, `  Заказы за ${label}`, `  Всего: ${rows.length}`,
    `  Выручка: ${rows.reduce((s, o) => s + parseInt(o.grand_total), 0).toLocaleString('ru')} ₽`, '════════════════════════════════', ''];
  rows.forEach(o => {
    const items = Array.isArray(o.items) ? o.items : JSON.parse(o.items || '[]');
    lines.push(`#${o.order_number}  ${o.time}  [${o.type === 'delivery' ? 'ДОСТАВКА' : 'САМОВЫВОЗ'}]  ${o.status}`);
    lines.push(`  ${o.customer}  ${o.phone}`);
    if (o.type === 'delivery') lines.push(`  ${o.address}`);
    items.forEach(i => lines.push(`  • ${i.name} ×${i.qty}  — ${i.price * i.qty} ₽`));
    lines.push(`  Итого: ${o.grand_total} ₽`, '');
  });
  fs.writeFileSync(path.join(dirPath, 'orders.txt'), lines.join('\n'), 'utf8');
  return { label, total: rows.length, dir: dirPath };
}

app.get('/api/:loc/bb/export/:date', staff, withLoc, allow(ROLES.manage), async (req, res) => {
  const [dd, mm, yy] = req.params.date.split('.');
  if (!dd || !mm || !yy) return res.status(400).json({ error: 'Формат: ДД.ММ.ГГ' });
  const date = new Date(`20${yy}-${mm}-${dd}`);
  if (isNaN(date)) return res.status(400).json({ error: 'Неверная дата' });
  try { res.json({ ok: true, ...(await exportOrders(date, req.place)) }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});
app.get('/api/:loc/bb/export-today', staff, withLoc, allow(ROLES.orders), async (req, res) => {
  try { res.json({ ok: true, ...(await exportOrders(new Date(), req.place)) }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});
app.get('/api/:loc/bb/exports', staff, withLoc, allow(ROLES.manage), (req, res) => {
  const dir = path.join(ORDERS_DIR, req.loc);
  try {
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(fs.readdirSync(dir).filter(d => /^\d{2}\.\d{2}\.\d{2}$/.test(d)).sort().reverse());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

function scheduleDailyExport() {
  async function runAll() {
    for (const place of Object.values(OWN)) {
      try { await exportOrders(new Date(), place); } catch (e) { console.error(`[${place.loc}] Ошибка экспорта:`, e.message); }
    }
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(now.getHours() < 12 ? 12 : 24, 0, 10, 0);
  setTimeout(() => { runAll(); setInterval(runAll, 12 * 60 * 60 * 1000); }, next - now);
}

// ─── Списание от имени сотрудника (личный PIN) — заявка уходит во Флагман ───
const WRITEOFF_ROLES = new Set(['COOK', 'CASHIER', 'STOREKEEPER', 'MANAGER']);
const WRITEOFF_REASONS = new Set(['DAMAGED', 'SPOILED', 'OTHER']);

// Кто может списывать (имена и роли, без секретов) и что есть на складе
app.get('/api/:loc/bb/writeoff/form', staff, withLoc, allow(ROLES.any), async (req, res) => {
  const fm = req.place.fm;
  try {
    // Остатки склада видны не каждой роли: в точке другого ресторана кассир их не видит — тогда список без остатков
    const [users, cat, stock] = await Promise.all([fm.pinUsers(req.loc), fm.catalogFull(),
      fm.stock(req.loc).catch(e => { if (!req.place.own && e.status === 403) return null; throw e; })]);
    const have = stock && Object.fromEntries(stock.map(p => [p.productId, p]));
    res.json({
      staff: users.filter(u => WRITEOFF_ROLES.has(u.role)).map(u => ({ id: u.id, name: u.name, role: u.role })),
      products: cat.products
        .filter(p => !have || have[p.id]?.available > 0)
        .map(p => ({ id: p.id, name: p.name, unit: p.unit, kind: p.kind, category: p.category || 'Прочее',
          available: have ? have[p.id].available : null, availableText: have ? have[p.id].availableText : null }))
        .sort((a, b) => a.category.localeCompare(b.category, 'ru') || a.name.localeCompare(b.name, 'ru')),
    });
  } catch (e) {
    if (!req.place.own) return fmFail(req, res, e);
    res.status(e.status === 0 ? 503 : 502).json({ ok: false, error: e.status === 0 ? 'Склад недоступен' : e.message });
  }
});

/**
 * Заявка на списание: напиток/блюдо из меню (по техкарте) или продукт со склада, причина, фото.
 * Автор — сотрудник, чей PIN введён; повар и кассир — всегда на подпись управляющему.
 */
// До 10 фото в base64 — без лимита «5 МБ» на фото; потолок запроса — от случайно огромных файлов.
app.post('/api/:loc/bb/writeoff', staff, withLoc, allow(ROLES.any), express.json({ limit: '300mb' }), async (req, res) => {
  const b = req.body || {};
  const reason = String(b.reason || '');
  const comment = sanitize(b.comment || '', 300);
  if (!b.userId || !/^\d{4,6}$/.test(String(b.pin || ''))) return res.status(400).json({ ok: false, error: 'Выберите сотрудника и введите PIN' });
  if (!WRITEOFF_REASONS.has(reason)) return res.status(400).json({ ok: false, error: 'Укажите причину' });
  if (reason === 'OTHER' && !comment) return res.status(400).json({ ok: false, error: 'Для причины «другое» нужен комментарий' });
  // Несколько фото (photos) или одно (photo — старые клиенты)
  const raw = Array.isArray(b.photos) ? b.photos : b.photo ? [b.photo] : [];
  if (!raw.length) return res.status(400).json({ ok: false, error: 'Нужно фото' });
  if (raw.length > 10) return res.status(400).json({ ok: false, error: 'Не больше 10 фото' });
  const photos = [];
  for (const [i, p] of raw.entries()) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(p || ''));
    if (!m) return res.status(400).json({ ok: false, error: `Фото ${i + 1}: нужен jpeg, png или webp` });
    photos.push({ type: m[1], buffer: Buffer.from(m[2], 'base64'), name: `writeoff-${i + 1}.` + m[1].split('/')[1] });
  }

  const fields = { reason, comment };
  try {
    if (b.kind === 'dish') {
      const v = await req.place.menu.variantFor(req.place, b);
      if (v.error) return res.status(400).json({ ok: false, error: v.error });
      fields.variantId = v.variantId;
      fields.portions = Math.max(1, Math.min(50, parseInt(b.portions) || 1));
    } else {
      const qty = Math.round(Number(b.qty));
      if (!b.productId || !(qty > 0)) return res.status(400).json({ ok: false, error: 'Выберите продукт и количество' });
      fields.productId = String(b.productId);
      fields.qty = qty;
    }
    const r = await flagman.writeoffAs(req.loc, b.userId, b.pin, fields, photos);
    events.emit(req.loc, 'writeoff.created', { pending: r.needsApproval });
    res.json({ ok: true, ...r });
  } catch (e) {
    const status = e.status === 0 ? 503 : e.status === 401 ? 403 : e.status >= 400 && e.status < 500 ? e.status : 502;
    res.status(status).json({ ok: false, error: e.status === 0 ? 'Склад недоступен' : e.message });
  }
});

// Неизвестный API — JSON, а не страница сайта
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'Нет такого метода' }));

// ═══════════════════════════════════════════════════════════════════
//  САЙТ И ПАНЕЛИ (статика; HTML/JS/CSS без кэша — всегда свежие)
// ═══════════════════════════════════════════════════════════════════
const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, '..', 'site');
app.use(express.static(SITE_DIR, {
  setHeaders(res, file) {
    if (/\.(html|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
  },
}));

// ═══════════════════════════════════════════════════════════════════
//  СТАРТ
// ═══════════════════════════════════════════════════════════════════
async function start() {
  for (const [loc, p] of Object.entries(pools)) {
    try {
      const { rows } = await p.query('SELECT COUNT(*) FROM bb_orders');
      console.log(`✅ [${loc}] PostgreSQL подключён. Заказов: ${rows[0].count}`);
    } catch (err) {
      console.error(`❌ [${loc}] Не удалось подключиться: ${err.message}`);
      console.error(`   Создайте базу: createdb istok_${loc} && psql -d istok_${loc} -f schema.sql`);
    }
  }
  if (flagman.configured()) {
    events.relayFlagman([...VALID_LOCATIONS], { onOrdersChanged: reconcileOrders });
    setInterval(() => retryPending().catch(e => console.error('retryPending:', e.message)), 30000);
  } else {
    console.warn('⚠️  FLAGMAN_API_KEY не задан — сайт работает без склада');
  }
  // HOST=127.0.0.1 — только этот компьютер (программа «Флагман» для Windows: без вопроса брандмауэра); не задан — все адреса
  const server = app.listen(PORT, process.env.HOST, () => {
    console.log('\n' + '═'.repeat(54));
    console.log('  ИСТОК — сайт, касса и панели ресторана');
    console.log('═'.repeat(54));
    console.log(`  Сайт:    http://localhost:${PORT}/`);
    console.log(`  Панель:  http://localhost:${PORT}/panel/login.html`);
    console.log(`  Склад:   ${flagman.BASE} (${flagman.configured() ? 'ключ задан' : 'КЛЮЧ НЕ ЗАДАН'})`);
    console.log('═'.repeat(54) + '\n');
    scheduleDailyExport();
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout   = 66000;
}

start();
