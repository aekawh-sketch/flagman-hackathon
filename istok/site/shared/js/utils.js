// ═══════════════════════════════════════════════════════════════
//  ИСТОК — утилиты
// ═══════════════════════════════════════════════════════════════

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Экранирование для вставки в HTML */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const nf = new Intl.NumberFormat('ru-RU');
export const num   = n => nf.format(Math.round(Number(n) || 0));
export const money = n => `${num(n)} ₽`;

/** plural(5, ['гость','гостя','гостей']) */
export function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Маска телефона: +7 (000) 000-00-00 */
export function maskPhone(value) {
  let d = String(value).replace(/\D/g, '');
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (d && !d.startsWith('7')) d = '7' + d;
  if (d.length > 11) d = '7' + d.slice(-10);   // вставили «+7 8…» или лишнее — берём последние 10 цифр
  let f = '';
  if (d.length > 0) f = '+7';
  if (d.length > 1) f += ' (' + d.slice(1, 4);
  if (d.length >= 4) f += ') ' + d.slice(4, 7);
  if (d.length >= 7) f += '-' + d.slice(7, 9);
  if (d.length >= 9) f += '-' + d.slice(9, 11);
  return f;
}
export const phoneDigits = v => String(v).replace(/\D/g, '');

/**
 * Подключает маску к полю телефона. Backspace корректно стирает цифры
 * (иначе маска сразу дописывает удалённый разделитель обратно).
 */
export function bindPhoneMask(input, { onInput } = {}) {
  let prev = input.value;
  input.addEventListener('input', e => {
    let v = input.value;
    if (e.inputType?.startsWith('delete') && phoneDigits(v) === phoneDigits(prev) && phoneDigits(v).length) {
      v = phoneDigits(v).slice(0, -1);      // удалили только разделитель — убираем и цифру
    }
    input.value = phoneDigits(v).length <= 1 && e.inputType?.startsWith('delete') ? '' : maskPhone(v);
    prev = input.value;
    onInput?.();
  });
  input.addEventListener('blur', () => { if (phoneDigits(input.value).length <= 1) { input.value = ''; prev = ''; } });
}

/** Нормализация для поиска: регистр и ё → е */
export const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
export function fmtDate(iso, opts = { day: '2-digit', month: 'short' }) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ru-RU', opts);
}
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
}
export const isoDay = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};

/** «через 5 ч», «через 2 дн», «просрочено 3 ч назад» */
export function fmtHoursLeft(h) {
  if (h == null || !isFinite(h)) return '—';
  if (h <= 0) {
    const a = Math.abs(h);
    return a < 1 ? 'просрочено' : a < 48 ? `просрочено ${Math.round(a)} ч` : `просрочено ${Math.round(a / 24)} дн`;
  }
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} мин`;
  if (h < 48) return `${Math.round(h)} ч`;
  return `${Math.round(h / 24)} дн`;
}

/** Минуты с момента ts: «5 мин», «1 ч 20 м» */
export function elapsed(ts) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} м`;
}

/** Количество продукта с единицей: 1 250 г → «1,25 кг» */
export function fmtQty(q, unit) {
  q = Number(q) || 0;
  if (unit === 'g' && Math.abs(q) >= 1000) return `${(q / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} кг`;
  if (unit === 'ml' && Math.abs(q) >= 1000) return `${(q / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} л`;
  const u = { g: 'г', ml: 'мл', pcs: 'шт' }[unit] ?? unit ?? '';
  return `${num(q)} ${u}`.trim();
}

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export const isTouch = () => window.matchMedia?.('(hover: none)').matches ?? false;

/** Безопасный доступ к localStorage */
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
