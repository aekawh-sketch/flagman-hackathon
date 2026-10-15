// ═══════════════════════════════════════════════════════════════
//  ИСТОК — конфигурация фронтенда
//  Всё, что может понадобиться поменять при деплое, — здесь.
// ═══════════════════════════════════════════════════════════════

/**
 * Адрес бэкенда.
 *  - Старый сервер слушал порт 3001 на том же хосте — оставлено по умолчанию.
 *  - Если бэкенд сам раздаёт фронтенд (тот же origin) — поставьте ''.
 *  - Можно переопределить без правки кода:  ?api=https://api.example.com
 *    (значение запоминается в localStorage 'istok_api').
 */
// Сайт раздаёт сам сервер ИСТОК — API на том же адресе (работает и через домен, и через туннель).
// Отдельный статический сервер (python -m http.server 5500) или file:// — бэкенд на :3001.
const DEFAULT_API = location.protocol === 'file:' || location.port === '5500'
  ? `http://${location.hostname || 'localhost'}:3001`
  : '';

function readOverride(param, key) {
  try {
    const q = new URLSearchParams(location.search).get(param);
    if (q !== null) { localStorage.setItem(key, q); return q; }
    return localStorage.getItem(key);
  } catch { return null; }
}

const apiOverride = readOverride('api', 'istok_api');

/**
 * Режим данных:
 *  'auto' — пробуем реальный бэкенд (/api/ping); если не отвечает — демо-данные (мок).
 *  'mock' — всегда демо-данные в браузере.
 *  'real' — всегда реальный бэкенд.
 * Переопределение: ?mode=mock | ?mode=real | ?mode=auto
 */
const modeOverride = readOverride('mode', 'istok_mode');

export const CONFIG = {
  API_BASE: apiOverride ?? DEFAULT_API,
  MODE: ['auto', 'mock', 'real'].includes(modeOverride) ? modeOverride : 'auto',

  /** Пароль входа в панель в ДЕМО-режиме (в реальном режиме проверяет сервер). */
  MOCK_PASSWORD: 'istok',

  /** Таймаут проверки доступности бэкенда, мс */
  PING_TIMEOUT: 1500,

  /** Интервал фолбэк-поллинга, если SSE недоступен, мс */
  POLL_INTERVAL: 7000,

  BRAND: {
    name: 'ИСТОК',
    tagline: 'Продукт и мастерство',
    slogan: 'Всё начинается со вкуса',
    kitchen: 'Бургеры · Пицца · Роллы',
  },

  /** Точки. Код точки используется в URL API: /api/{code}/bb/... */
  /** Точки. Код точки используется в URL API: /api/{code}/bb/...
   *  ⚠ Все названия, адреса и телефоны ВЫМЫШЛЕННЫЕ (демо). Код +7 (000) не существует. */
  LOCATIONS: {
    kush: {
      code: 'kush',
      name: 'г. Истокград',
      city: 'Истокград',
      cityIn: 'Истокграде',
      addrPrefix: 'г. Истокград, ',
      street: 'ул. Солнечная, 12',
      phone: '+7 (000) 100-20-30',
      phoneTel: '+70001002030',
      hours: 'Пн–Вс 10:00 — 23:00',
      open: 10, close: 23,       // часы работы (для статуса «Готовим / Закрыто»)
      rating: '4.9',
      reviews: '860 отзывов',
    },
    kan: {
      code: 'kan',
      name: 'пос. Ясноречье',
      city: 'Ясноречье',
      cityIn: 'Ясноречье',
      addrPrefix: 'пос. Ясноречье, ',
      street: 'Речной проспект, 8',
      phone: '+7 (000) 400-50-60',
      phoneTel: '+70004005060',
      hours: 'Пн–Вс 10:00 — 22:00',
      open: 10, close: 22,
      rating: '4.8',
      reviews: '412 отзывов',
    },
  },

  DELIVERY: {
    fee: 150,            // ₽ при сумме ниже порога
    freeFrom: 1000,      // ₽ — бесплатная доставка
    eta: '40–60 мин',
  },

  /** Статусы заказа — строки совпадают со старым бэкендом, менять нельзя */
  STATUS: {
    NEW: 'Новый',
    ACCEPTED: 'Принят',
    COOKING: 'Готовится',
    READY: 'Готов к выдаче',
    ON_WAY: 'В пути',
    DONE: 'Выполнен',
    CANCELLED: 'Отменён',
  },
};

export const DONE_STATUSES = [CONFIG.STATUS.DONE, CONFIG.STATUS.CANCELLED];

/** Пороги «свежести» партий, часы */
export const EXPIRY = {
  CRITICAL_H: 24,   // ≤ 24 ч — красный
  WARNING_H: 72,    // ≤ 72 ч — жёлтый
};
