// ═══════════════════════════════════════════════════════════════
//  Портал поставщика «ФрешПоставка» — внешняя система, которая шлёт поставки
//  в склады ресторанов (Флагман) по API. Ключ Флагмана живёт только здесь, на сервере:
//  браузер видит лишь свои запросы к этому серверу. Ключ — поставщика платформы:
//  открыты все предприятия Флагмана, в том числе созданные позже.
//  Запуск: node --env-file=.env server.js   (Node 22, без зависимостей)
// ═══════════════════════════════════════════════════════════════
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3002);
const FLAGMAN = (process.env.FLAGMAN_URL || 'http://localhost:8080').replace(/\/$/, '');
const KEY = process.env.FLAGMAN_API_KEY || '';
const SUPPLIER = process.env.SUPPLIER_NAME || 'ООО «ФрешПоставка»';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TIMEOUT_MS = 8000;
const LOC_RE = /^[a-z0-9-]{1,40}$/;

if (!KEY) console.warn('⚠️  FLAGMAN_API_KEY не задан — склад не примет поставки');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ── Флагман ────────────────────────────────────────────────────
async function flagman(method, url, { body, contentType } = {}) {
  const res = await fetch(FLAGMAN + url, {
    method,
    headers: { 'X-Api-Key': KEY, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Тот же документ в XML (формат Флагмана, ТЗ 16.3): поля — атрибутами, строки — <line>. */
function toXml(d) {
  const attrs = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  const head = attrs({ id: d.id, number: d.number, createdAt: d.createdAt, supplier: d.supplier });
  const lines = d.lines.map((l) => `  <line ${attrs(l)}/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<delivery ${head}>\n${lines}\n</delivery>\n`;
}

/** Документ поставки из формы: только известные поля, поставщик — всегда наш. */
function cleanDelivery(d) {
  if (!d || typeof d !== 'object') throw new Error('Нет документа поставки');
  const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
  const lines = Array.isArray(d.lines) ? d.lines.slice(0, 50) : [];
  if (!lines.length) throw new Error('В поставке нет позиций');
  return {
    id: str(d.id, 60),
    number: str(d.number, 40),
    createdAt: new Date(d.createdAt).toISOString(),
    supplier: SUPPLIER,
    lines: lines.map((l) => ({
      productId: str(l.productId, 60), name: str(l.name, 120), unit: str(l.unit, 3),
      qty: Math.round(Number(l.qty)),
      shelfLifeHours: l.shelfLifeHours ? Math.round(Number(l.shelfLifeHours)) : undefined,
      costKop: l.costKop ? Math.round(Number(l.costKop)) : undefined,
    })),
  };
}

// ── HTTP ───────────────────────────────────────────────────────
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Слишком большой запрос');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const routes = {
  /**
   * Куда можно отправлять: рестораны платформы и их точки — по нашему ключу поставщика платформы.
   * Новые предприятия появляются сами (сверху, с пометкой «новое» первую неделю).
   */
  'GET /api/info': async () => {
    const r = await flagman('GET', '/api/supplier/restaurants');
    if (r.status !== 200) {
      return [r.status === 401 || r.status === 403 ? r.status : 502,
        { connected: false, error: r.data?.error || 'Склад не ответил' }];
    }
    const week = Date.now() - 7 * 86400e3;
    return [200, { connected: !!KEY, supplier: SUPPLIER, keyPrefix: KEY.slice(0, 12),
      restaurants: r.data.map((t) => ({ id: t.tenantId, name: t.name, isNew: Date.parse(t.createdAt) > week,
        locations: t.locations.map((l) => ({ id: l.id, name: l.name })) })) }];
  },

  /** Продукты ресторана этой точки: поставщик привозит то, что есть в его каталоге (или новый продукт). */
  'GET /api/catalog': async (req, url) => {
    const loc = url.searchParams.get('location') || '';
    if (!LOC_RE.test(loc)) return [400, { error: 'Нет точки' }];
    const r = await flagman('GET', `/api/${loc}/supply-catalog`);
    if (r.status !== 200) return [r.status, { error: r.data?.error || 'Каталог недоступен' }];
    return [200, r.data];
  },

  /** Отгрузка: ровно то, что ушло во Флагман, и ровно то, что он ответил. */
  'POST /api/send': async (req) => {
    const body = await readBody(req);
    const loc = String(body.location || '');
    if (!LOC_RE.test(loc)) return [400, { error: 'Выберите точку' }];
    const d = cleanDelivery(body.delivery);
    const xml = body.format === 'xml';
    const payload = xml ? toXml(d) : JSON.stringify(d, null, 2);
    const contentType = xml ? 'application/xml' : 'application/json';
    const url = `/api/${loc}/deliveries`;
    const r = await flagman('POST', url, { body: payload, contentType });
    return [200, {
      status: r.status, response: r.data,
      request: { method: 'POST', url: FLAGMAN + url, contentType, apiKey: KEY.slice(0, 12) + '…', body: payload },
    }];
  },

  /** Наши отгрузки и что с ними сделал ресторан: принял, частично, отклонил. */
  'GET /api/deliveries': async (req, url) => {
    const loc = url.searchParams.get('location') || '';
    if (!LOC_RE.test(loc)) return [400, { error: 'Нет точки' }];
    const r = await flagman('GET', `/api/${loc}/deliveries`);
    if (r.status !== 200) return [r.status, { error: r.data?.error || 'Склад не ответил' }];
    return [200, r.data.filter((d) => d.supplier === SUPPLIER).slice(0, 30)];
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route) {
      const [status, data] = await route(req, url);
      return send(res, status, data);
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Метод не поддерживается' });
    // Статика: только из public/, без выхода наружу через «..».
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'Не найдено' });
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, { error: 'Не найдено' });
    // Любая сетевая ошибка fetch (склад выключен, перезапускается, не отвечает) — для пользователя одно и то же.
    const offline = e.name === 'TimeoutError' || (e instanceof TypeError && e.message === 'fetch failed');
    send(res, offline ? 502 : 400, { error: offline ? 'Склад ресторана недоступен' : e.message });
  }
});

// HOST=0.0.0.0 — на сервере в Docker (deploy/docker-compose.yml во Флагмане); по умолчанию — только этот компьютер
server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`🚚 Портал поставщика: http://localhost:${PORT} → склад ${FLAGMAN}`));
