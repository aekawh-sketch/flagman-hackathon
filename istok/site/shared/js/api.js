// ═══════════════════════════════════════════════════════════════
//  ИСТОК — API-клиент
//  Единственная точка общения фронта с бэкендом. Каждый метод
//  соответствует эндпоинту из API_CONTRACT.md.
//  Режим 'mock' направляет те же запросы в браузерный мок-сервер.
// ═══════════════════════════════════════════════════════════════
import { CONFIG } from './config.js';
import { CATEGORIES, ALL_ITEMS } from './menu-catalog.js';

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Ошибка сервера (${status})`);
    this.status = status;
    this.data = data || {};
    this.code = data?.code;
  }
}

let mode = null;          // 'mock' | 'real'
let modePromise = null;
let mockModule = null;

async function getMock() {
  if (!mockModule) mockModule = await import('./mock/server.js');
  return mockModule;
}

/** Определяет режим работы один раз за загрузку страницы */
export function resolveMode() {
  if (modePromise) return modePromise;
  modePromise = (async () => {
    if (CONFIG.MODE === 'mock') return (mode = 'mock');
    if (CONFIG.MODE === 'real') return (mode = 'real');
    // результат проверки кэшируем на 2 минуты в рамках вкладки — без задержки на каждой странице
    try {
      const c = JSON.parse(sessionStorage.getItem('istok_mode') || 'null');
      if (c && c.api === CONFIG.API_BASE && Date.now() - c.at < 120e3) return (mode = c.mode);
    } catch {}
    try {
      const r = await fetch(`${CONFIG.API_BASE}/api/ping`, { signal: AbortSignal.timeout(CONFIG.PING_TIMEOUT) });
      mode = r.ok ? 'real' : 'mock';
    } catch { mode = 'mock'; }
    try { sessionStorage.setItem('istok_mode', JSON.stringify({ mode, api: CONFIG.API_BASE, at: Date.now() })); } catch {}
    return mode;
  })();
  return modePromise;
}
export const getMode = () => mode;

/** Низкоуровневый запрос. path начинается с /api/... */
export async function request(method, path, body, { raw = false } = {}) {
  const m = await resolveMode();
  if (m === 'mock') {
    const { mockFetch } = await getMock();
    const res = await mockFetch(method, path, body);
    if (res.blob) return { blob: res.blob, filename: res.filename };
    if (res.status >= 400) throw new ApiError(res.status, res.json);
    return res.json;
  }
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${CONFIG.API_BASE}${path}`, opts);
  } catch (e) {
    throw new ApiError(0, { error: 'Сервер недоступен' });
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    const cd = res.headers.get('Content-Disposition') || '';
    const fn = decodeURIComponent((cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || '');
    return { blob: await res.blob(), filename: fn };
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  // Сессия панели кончилась (смена 10 ч, вход в склад истёк) — со страницы панели сразу на вход, с возвратом
  if (res.status === 401 && /\/panel\/(?!login\.html)/.test(location.pathname) && !/^\/api\/(login|workplace)\b/.test(path)) {
    location.href = `login.html?back=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`;
  }
  // Старый бэкенд мог отвечать 200 + { ok:false, error } — считаем это ошибкой
  if (!res.ok || data?.ok === false) throw new ApiError(res.status, data);
  return data;
}

const bb = loc => `/api/${loc}/bb`;
const qs = o => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString(); return s ? `?${s}` : ''; };

// ═══════════════════════════════════════════════════════════════
export const api = {
  // ── Общие ──
  ping:      ()      => request('GET',  '/api/ping'),
  /**
   * Логин и пароль — из Флагмана; без логина — служебный пароль владельца ИСТОК.
   * Ответ: { user, person, workplaces } — user есть, если место работы одно (сразу в него).
   */
  login:     (login, password) => request('POST', '/api/login', { login, password }),
  /** Выбрать место работы — ресторан и точку: { user } с ролью уже в нём */
  workplace: loc => request('POST', '/api/workplace', { loc }),
  logout:    ()      => request('POST', '/api/logout', {}),
  /**
   * Кто работает в панели: { login, name, role, service, tenantName, own, loc, places, multi } или null
   * (не вошёл или ещё не выбрал место работы).
   */
  authCheck: async () => (await api.session()).user,
  /** Сессия целиком: { user, person, workplaces } — person без user значит «вошёл, но место не выбрал». */
  session: async () => {
    try {
      const r = await request('GET', '/api/auth-check').catch(e => (e.status === 200 ? e.data : null));
      return { user: r?.user || null, person: r?.person || null, workplaces: r?.workplaces || [] };
    } catch { return { user: null, person: null, workplaces: [] }; }
  },

  // ── Клиентский сайт ──
  /**
   * Меню с доступностью. Если бэкенд ещё не умеет GET /menu —
   * собираем из локального каталога + /stoplist + /hot-offers.
   */
  /** Касса: сколько ещё можно пробить каждой позиции после корзины { id, size, variant, qty }. */
  menuLeft: (loc, lines) => request('POST', `${bb(loc)}/menu/left`, { lines }),

  async menu(loc) {
    try {
      const d = await request('GET', `${bb(loc)}/menu`);
      if (d && Array.isArray(d.items)) return d;
    } catch (e) { if (e.status && e.status !== 404 && e.status !== 405) console.warn('[api] /menu:', e.message); }
    const [stop, hot] = await Promise.all([
      request('GET', `${bb(loc)}/stoplist`).catch(() => ({ items: [] })),
      request('GET', `${bb(loc)}/hot-offers`).catch(() => ({ items: [] })),
    ]);
    const stopMap = Object.fromEntries((stop?.items || []).map(s => [s.id, s]));
    const hotMap = Object.fromEntries((hot?.items || []).map(h => [h.id, h]));
    return {
      categories: CATEGORIES,
      items: ALL_ITEMS.map(it => ({
        ...it,
        available: !stopMap[it.id],
        stop_reason: stopMap[it.id]?.reason || null,
        hot: hotMap[it.id] ? { priority: hotMap[it.id].priority, level: hotMap[it.id].level, reason_public: hotMap[it.id].reason_public || 'Шеф рекомендует сегодня' } : null,
      })),
      fallback: true,
    };
  },
  order:   (loc, payload) => request('POST', `${bb(loc)}/order`, payload),
  track:   (loc, num)     => request('GET',  `${bb(loc)}/track/${encodeURIComponent(num)}`),
  confirm: (loc, num)     => request('POST', `${bb(loc)}/confirm/${encodeURIComponent(num)}`, {}),

  // ── Панель: заказы (старый контракт) ──
  orders:      loc               => request('GET',   `${bb(loc)}/orders`),
  setStatus:   (loc, id, status) => request('PATCH', `${bb(loc)}/orders/${id}/status`, { status }),
  stats:       loc               => request('GET',   `${bb(loc)}/stats`),
  cashier:     (loc, payload)    => request('POST',  `${bb(loc)}/cashier`, payload),
  fixStatuses: loc               => request('POST',  `${bb(loc)}/fix-statuses`, {}),
  clearDone:   loc               => request('DELETE', `${bb(loc)}/orders/clear-done`),
  clearActive: loc               => request('DELETE', `${bb(loc)}/orders/clear-active`),
  clearAll:    loc               => request('DELETE', `${bb(loc)}/orders/all`),
  exportToday: loc               => request('GET',   `${bb(loc)}/export-today`),

  // ── Бухгалтерия ──
  accSummary: (loc, from, to) => request('GET', `${bb(loc)}/accounting/summary${qs({ from, to })}`),
  accDaily:   (loc, from, to) => request('GET', `${bb(loc)}/accounting/daily${qs({ from, to })}`),
  accItems:   (loc, from, to) => request('GET', `${bb(loc)}/accounting/items${qs({ from, to })}`),
  accExcel:   (loc, from, to) => request('GET', `${bb(loc)}/accounting/excel${qs({ from, to })}`, null, { raw: true }),

  // ── Склад (новый контракт) ──
  products:   loc            => request('GET',  `${bb(loc)}/products`),
  stock:      loc            => request('GET',  `${bb(loc)}/stock`),
  batches:    (loc, hours)   => request('GET',  `${bb(loc)}/batches${qs({ expiring_hours: hours })}`),
  supplies:   loc            => request('GET',  `${bb(loc)}/supplies`),
  addSupply:  (loc, payload) => request('POST', `${bb(loc)}/supplies`, payload),
  writeoffs:  (loc, days = 7) => request('GET', `${bb(loc)}/writeoffs${qs({ days })}`),
  addWriteoff:(loc, payload) => request('POST', `${bb(loc)}/writeoffs`, payload),
  expireNow:  loc            => request('POST', `${bb(loc)}/writeoffs/expire`, {}),
  stoplist:   loc            => request('GET',  `${bb(loc)}/stoplist`),
  hotOffers:  loc            => request('GET',  `${bb(loc)}/hot-offers`),
  forecast:   loc            => request('GET',  `${bb(loc)}/forecast`),
  purchase:   loc            => request('GET',  `${bb(loc)}/purchase-suggestions`),
  analytics:  (loc, days = 7) => request('GET', `${bb(loc)}/analytics${qs({ days })}`),

  // ── Списание (реальный режим: заявка уходит в склад «Флагман» от имени сотрудника) ──
  writeoffForm: loc => request('GET', `${bb(loc)}/writeoff/form`),
  writeoff: (loc, payload) => request('POST', `${bb(loc)}/writeoff`, payload),

  // ── Эмулятор событий ──
  simSupply: loc => request('POST', `${bb(loc)}/simulate/supply`, {}),
  simOrder:  loc => request('POST', `${bb(loc)}/simulate/order`, {}),
  resetDemo: loc => request('POST', `${bb(loc)}/demo/reset`, {}),
};

/** Скачивание blob как файла */
export function saveBlob({ blob, filename }, fallbackName = 'report.xlsx') {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename || fallbackName });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
