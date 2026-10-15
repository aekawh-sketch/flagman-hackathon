'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Клиент склада «Флагман». Сайт ресторана — внешняя система: ходит
//  по API-ключу с узкими правами (заказы, меню, чтение склада).
//  Списания, приёмка и инвентаризация по ключу невозможны — только
//  сотрудником во Флагмане (антифрод).
//  Точки других ресторанов панель обслуживает сессией самого сотрудника
//  (as(cookie)): ключа у неё нет, права — его роль во Флагмане.
// ═══════════════════════════════════════════════════════════════════

const BASE = (process.env.FLAGMAN_URL || 'http://localhost:8080').replace(/\/+$/, '');
const KEY = process.env.FLAGMAN_API_KEY || '';
const TIMEOUT_MS = Number(process.env.FLAGMAN_TIMEOUT_MS || 4000);

class FlagmanError extends Error {
  /** status 0 — склад недоступен (сеть, таймаут) */
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * auth — как ходить во Флагман: по ключу сайта (своя точка ИСТОК) или cookie сессии сотрудника
 * (точка другого ресторана: склад видит самого человека и проверяет его роль).
 */
async function call(method, path, body, auth = {}) {
  const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
  if (auth.cookie) headers.Cookie = auth.cookie;
  else if (!KEY) throw new FlagmanError(0, 'FLAGMAN_API_KEY не задан в .env');
  else headers['X-Api-Key'] = KEY;
  let res;
  try {
    res = await fetch(BASE + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new FlagmanError(0, 'Склад недоступен: ' + (e.cause?.code || e.name || e.message));
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new FlagmanError(res.status, data?.error || `Склад ответил ${res.status}`, data?.details);
    // Сессия сотрудника во Флагмане кончилась (истекла или склад перезапущен) — нужно войти заново
    err.expired = !!auth.cookie && res.status === 401;
    throw err;
  }
  return { status: res.status, data };
}

// Короткий кэш чтений: меню и стоп-лист запрашивают и сайт, и панели, и каждый заказ.
// Пути с точкой общие для всех, кто в ней работает (точки у разных ресторанов разные).
const cache = new Map();
async function cached(path, ttlMs, auth) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = call('GET', path, undefined, auth).then(r => r.data);
  cache.set(path, { at: Date.now(), promise });
  promise.catch(() => cache.delete(path));
  return promise;
}
const invalidate = loc => { for (const k of cache.keys()) if (k.startsWith(`/api/${loc}/`)) cache.delete(k); };

const q = o => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? `?${s}` : '';
};

/** Методы склада для точки — одинаковые для ключа сайта и для сессии сотрудника. */
function client(auth = {}) {
  const get = path => call('GET', path, undefined, auth).then(r => r.data);
  return {
    // Каталог зависит от предприятия: по ключу — ИСТОК, по сессии — предприятие сотрудника; его не делим
    catalogFull: () => (auth.cookie ? get('/api/catalog') : cached('/api/catalog', 60000, auth)),
    // Остатки склада видны не каждой роли (кассиру — нет): по сессии не кэшируем, чтобы не отдать чужой ответ
    stock: loc => (auth.cookie ? get(`/api/${loc}/stock`) : cached(`/api/${loc}/stock`, 3000, auth)),
    /** Сотрудники точки с PIN — только имена и роли, без секретов (тот же список, что на экране PIN) */
    pinUsers: loc => cached(`/api/auth/pin-users${q({ location: loc })}`, 30000, auth),
    menu: loc => cached(`/api/${loc}/menu`, 3000, auth),
    /** Меню за вычетом корзины кассы: сколько порций каждого блюда ещё пропустит склад. */
    menuLeft: (loc, lines) => call('POST', `/api/${loc}/menu/left`, { lines }, auth).then(r => r.data),
    hotOffers: loc => cached(`/api/${loc}/hot-offers`, 10000, auth),
    orders: (loc, limit = 100) => get(`/api/${loc}/orders${q({ limit })}`),
    /** 201 — создан, 200 — повтор с тем же externalId, 409 — отказ (FlagmanError.details = Refusal) */
    createOrder: (loc, body) => call('POST', `/api/${loc}/orders`, body, auth).then(r => { invalidate(loc); return r.data; }),
    setOrderStatus: (loc, id, status) => call('POST', `/api/${loc}/orders/${id}/status`, { status }, auth).then(r => r.data),
    cancelOrder: (loc, id, reason) => call('POST', `/api/${loc}/orders/${id}/cancel`, { reason }, auth)
      .then(r => { invalidate(loc); return r.data; }),
  };
}

const cookieOf = res => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

module.exports = {
  FlagmanError,
  BASE,
  configured: () => !!KEY,
  invalidate,

  ...client(),
  /** Те же методы от имени сотрудника — его сессией во Флагмане (точки других ресторанов). */
  as: cookie => client({ cookie }),

  /**
   * Вход сотрудника панели логином и паролем Флагмана. Сессию склада панель держит у себя (в браузер она
   * не уходит): по ней видно, где человек работает, а в точках других ресторанов панель действует от его имени —
   * склад сам проверяет роль. Выход из панели закрывает и её.
   * @returns {{ me, cookie }}
   */
  async staffLogin(login, password) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }), signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(e => { throw new FlagmanError(0, 'Склад недоступен: ' + (e.cause?.code || e.message)); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new FlagmanError(res.status, data.error || `Склад ответил ${res.status}`);
    return { me: data, cookie: cookieOf(res) };
  },
  /** Где человек работает: [{ tenantId, tenantName, role, locations: [{ id, name }] }] */
  workplaces: cookie => call('GET', '/api/auth/workplaces', undefined, { cookie }).then(r => r.data),
  /** Перевести сессию склада в предприятие места работы: роль — уже в нём */
  switchTenant: (cookie, tenantId) => call('POST', '/api/auth/tenant', { tenantId }, { cookie }).then(r => r.data),
  logout(cookie) {
    if (cookie) fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } }).catch(() => {});
  },

  /**
   * Заявка на списание ОТ ИМЕНИ сотрудника: вход по его личному PIN, заявка, выход.
   * Ключ сайта здесь не передаём — иначе склад увидел бы «сайт», а не человека: в журнале и в правилах
   * антифрода автор — тот, кто ввёл PIN. Неверный PIN и блокировку после попыток проверяет сам Флагман.
   * fields — поля формы (variantId+portions или productId+qty, reason, comment), photos — [{ buffer, type, name }].
   */
  async writeoffAs(loc, userId, pin, fields, photos) {
    const login = await fetch(`${BASE}/api/auth/pin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Точка — чтобы войти именно в предприятие этой точки (во Флагмане человек может работать в нескольких)
      body: JSON.stringify({ userId: Number(userId), pin: String(pin), location: loc }), signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(e => { throw new FlagmanError(0, 'Склад недоступен: ' + (e.cause?.code || e.message)); });
    if (!login.ok) {
      const d = await login.json().catch(() => ({}));
      throw new FlagmanError(login.status === 401 ? 401 : login.status, d.error || 'Не удалось войти по PIN');
    }
    const cookie = cookieOf(login);
    try {
      const form = new FormData();
      Object.entries(fields).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') form.append(k, String(v)); });
      for (const p of photos) form.append('photo', new Blob([p.buffer], { type: p.type }), p.name);
      const res = await fetch(`${BASE}/api/${loc}/writeoff-requests/fefo`, {
        method: 'POST', headers: { Cookie: cookie }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS * 3),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new FlagmanError(res.status, data.error || `Склад ответил ${res.status}`, data.details);
      invalidate(loc);
      return data;
    } finally {
      fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } }).catch(() => {});
    }
  },

  /**
   * Подписка на живые события склада (SSE) с переподключением.
   * onEvent(type, data) — например ('stock', { reasons: ['order.status'], stopList: true }).
   */
  subscribe(loc, onEvent) {
    let stopped = false;
    let ctrl = null;
    const run = async () => {
      while (!stopped) {
        try {
          ctrl = new AbortController();
          const res = await fetch(`${BASE}/api/${loc}/events`, { headers: { 'X-Api-Key': KEY, Accept: 'text/event-stream' }, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          const decoder = new TextDecoder();
          let buf = '';
          for await (const chunk of res.body) {
            buf += decoder.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let type = 'message';
              const data = [];
              for (const line of raw.split('\n')) {
                if (line.startsWith('event:')) type = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
              }
              let parsed = null;
              try { parsed = data.length ? JSON.parse(data.join('\n')) : null; } catch { parsed = data.join('\n'); }
              try { onEvent(type, parsed); } catch (e) { console.error('[flagman] обработчик события:', e.message); }
            }
          }
        } catch (e) {
          if (stopped) return;
          if (e.name !== 'AbortError') console.warn(`[flagman] события ${loc}: ${e.message} — переподключение через 5 с`);
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    };
    run();
    return () => { stopped = true; ctrl?.abort(); };
  },
};
