// ═══════════════════════════════════════════════════════════════
//  ИСТОК — общие UI-примитивы: иконки, тосты, модалки, тема
// ═══════════════════════════════════════════════════════════════
import { esc } from './utils.js';

// ── Иконки (stroke 1.8, 24×24, в стиле Lucide) ─────────────────
const P = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3h2.6l2.4 12.2a1.5 1.5 0 0 0 1.5 1.2h9.1a1.5 1.5 0 0 0 1.5-1.1L21.5 7H6"/>',
  bag: '<path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  flame: '<path d="M12 22c4 0 7-2.7 7-6.6 0-3.4-2.3-5.6-3.6-7.4-.4 1.6-1.3 2.7-2.4 3.2C13.6 7.6 12 4.4 9.5 2.5 9.6 6 6 8.4 6 13c0 .6 0 1.2.2 1.8C5.4 14.4 5 13.6 5 12.6 4.4 13.5 5 15.4 5 15.4 5 19.3 8 22 12 22Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M5 3h3.5l1.6 4.5-2.2 1.4a11 11 0 0 0 7.2 7.2l1.4-2.2L21 15.5V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2Z"/>',
  truck: '<path d="M2 6h11v10H2zM13 9h4.5L21 12.5V16h-8"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  scooter: '<circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M8 17.5h8M15 6h2l3 11.5M6 11h6l2 6.5"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  chef: '<path d="M7 21h10M7 17h10v4H7z"/><path d="M7 17V12a4 4 0 0 1-1-7.5A4.5 4.5 0 0 1 12 3a4.5 4.5 0 0 1 6 1.5A4 4 0 0 1 17 12v5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>',
  bars: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M3 21v-5h5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 4 13c0-6 5-9 16-10-1 11-4 16-10 16Z"/><path d="M4 21c4-6 8-9 12-11"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
  table: '<path d="M3 8h18M5 8v12M19 8v12M8 8v5h8V8"/>',
  store: '<path d="M3 9 4.5 4h15L21 9M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V9ZM5 13v8h14v-8M10 21v-5h4v5"/>',
  warehouse: '<path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-9h10v9M7 15h10M7 18h10"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  filter: '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  map: '<path d="m9 4-6 2.5v14L9 18l6 2.5 6-2.5V4l-6 2.5L9 4ZM9 4v14M15 6.5v14"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z"/>',
  thermometer: '<path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0Z"/>',
  trendDown: '<path d="m3 7 7 7 4-4 7 7M21 11v6h-6"/>',
  trendUp: '<path d="m3 17 7-7 4 4 7-7M21 13V7h-6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  hourglass: '<path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"/>',
  scale: '<path d="M12 3v18M5 21h14M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0L5 7ZM19 7l-3 7a3.5 3.5 0 0 0 6 0l-3-7Z"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.dot}</svg>`;
}

// ── Тосты ──────────────────────────────────────────────────────
let toastRoot;
const canPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    toastRoot.className = 'toasts';
    toastRoot.setAttribute('role', 'status');
    toastRoot.setAttribute('aria-live', 'polite');
    // popover живёт в top-layer — тосты видны даже поверх открытого <dialog>
    if (canPopover) toastRoot.popover = 'manual';
    document.body.appendChild(toastRoot);
  }
  if (canPopover) {
    try { if (toastRoot.matches(':popover-open')) toastRoot.hidePopover(); toastRoot.showPopover(); } catch {}
  }
  return toastRoot;
}

/**
 * toast('Добавлено', { text, type: 'ok'|'err'|'warn'|'info', img, icon, timeout })
 */
export function toast(title, opts = {}) {
  const { text = '', type = 'info', img = '', icon: ic, timeout = 2800 } = opts;
  const root = ensureToastRoot();
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  const defaultIcon = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  el.innerHTML = `
    <div class="toast-ico">${img ? `<img src="${esc(img)}" alt="">` : icon(ic || defaultIcon)}</div>
    <div class="toast-body"><div class="toast-title">${esc(title)}</div>${text ? `<div class="toast-text">${esc(text)}</div>` : ''}</div>
    <button class="toast-x" type="button" aria-label="Закрыть уведомление">${icon('x')}</button>`;
  root.insertBefore(el, root.querySelector('.toasts-clear'));
  const all = root.querySelectorAll('.toast');
  for (let i = 0; i < all.length - 3; i++) all[i].remove();
  let gone = false;
  el._kill = () => {
    if (gone) return;
    gone = true;
    el.classList.add('out');
    syncClearAll(root);
    setTimeout(() => { el.remove(); syncClearAll(root); }, 260);
  };
  setTimeout(el._kill, timeout);
  el.addEventListener('click', el._kill);          // и крестик, и клик по самому уведомлению закрывают его
  syncClearAll(root);
  return el;
}

/** Два уведомления и больше — над ними кнопка «Убрать все». */
function syncClearAll(root) {
  const live = root.querySelectorAll('.toast:not(.out)');
  let btn = root.querySelector('.toasts-clear');
  if (live.length < 2) { btn?.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toasts-clear';
    btn.addEventListener('click', () => root.querySelectorAll('.toast').forEach(t => t._kill?.()));
  }
  btn.textContent = `Убрать все (${live.length})`;
  root.appendChild(btn);                            // последним: в column-reverse — над всеми уведомлениями
}

// ── Модалки на <dialog> ────────────────────────────────────────
let modalSeq = 0;
function wire(dlg) {
  if (dlg._wired) return;
  dlg._wired = true;
  // клик по подложке
  dlg.addEventListener('click', e => { if (e.target === dlg) closeModal(dlg); });
  // Esc — с анимацией (если браузер разрешит отменить нативное закрытие)
  dlg.addEventListener('cancel', e => { e.preventDefault(); closeModal(dlg); });
  // Любое закрытие (в т.ч. нативное, без анимации) → единое событие 'closed'
  dlg.addEventListener('close', () => {
    dlg.classList.remove('closing');
    document.documentElement.classList.toggle('has-dialog', !!document.querySelector('dialog[open]'));
    dlg.dispatchEvent(new CustomEvent('closed'));
  });
}
export function openModal(dlg) {
  if (!dlg || dlg.open) return;
  wire(dlg);
  dlg.classList.remove('closing');
  // доступное имя диалога
  const title = dlg.querySelector('.modal-title');
  if (title && !dlg.hasAttribute('aria-labelledby')) {
    title.id ||= `mt${++modalSeq}`;
    dlg.setAttribute('aria-labelledby', title.id);
  }
  dlg.showModal();
  document.documentElement.classList.add('has-dialog');
}
export function closeModal(dlg) {
  if (!dlg || !dlg.open || dlg.classList.contains('closing')) return;
  dlg.classList.add('closing');
  setTimeout(() => { if (dlg.open) dlg.close(); }, 200);
}

/** Создаёт модалку из HTML-разметки (содержимое .modal-box) и возвращает <dialog> */
export function createModal(innerHtml, { className = '' } = {}) {
  const d = document.createElement('dialog');
  d.className = `modal ${className}`;
  d.innerHTML = `<div class="modal-box">${innerHtml}</div>`;
  document.body.appendChild(d);
  d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(d)));
  wire(d);
  return d;
}

/** Диалог подтверждения → Promise<boolean> */
export function confirmDialog({ title, text = '', ok = 'Подтвердить', cancel = 'Отмена', danger = false, iconName = danger ? 'alert' : 'info' }) {
  return new Promise(resolve => {
    const d = createModal(`
      <div class="modal-body confirm-body" style="padding-top:26px;text-align:center">
        <div class="confirm-ico ${danger ? 'is-danger' : ''}">${icon(iconName)}</div>
        <div class="modal-title" style="font-size:1.6rem;margin-top:14px">${esc(title)}</div>
        ${text ? `<p class="modal-sub" style="margin-top:10px">${text}</p>` : ''}
      </div>
      <div class="modal-foot" style="border:0;padding-top:4px">
        <button class="btn btn--ghost btn--lg" style="flex:1" data-act="no">${esc(cancel)}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'} btn--lg" style="flex:1" data-act="yes">${esc(ok)}</button>
      </div>`, { className: 'modal--confirm' });
    d.style.maxWidth = '420px';
    let result = false;
    d.querySelector('[data-act="yes"]').onclick = () => { result = true; closeModal(d); };
    d.querySelector('[data-act="no"]').onclick = () => closeModal(d);
    d.addEventListener('closed', () => { d.remove(); resolve(result); });
    openModal(d);
    d.querySelector('[data-act="yes"]').focus();
  });
}

// ── Тема ───────────────────────────────────────────────────────
const THEME_KEY = 'istok_theme';

/** Текущая тема: сохранённая или системная */
export function currentTheme() {
  return document.documentElement.dataset.theme || 'dark';
}

export function setTheme(theme, { from } = {}) {
  const apply = () => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#14110F' : '#F6EFE6');
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
    window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce || !from) { apply(); return; }
  // Круговое «раскрытие» новой темы от кнопки
  const r = from.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const t = document.startViewTransition(apply);
  t.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
      { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
}

export function themeToggleButton() {
  return `<button class="theme-toggle" type="button" data-theme-toggle aria-label="Сменить тему" title="Сменить тему">
    ${icon('sun', 'i-sun')}${icon('moon', 'i-moon')}
  </button>`;
}

export function wireThemeToggles(root = document) {
  root.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark', { from: btn }));
  });
}

/** Счётчик-«бегунок» для чисел */
export function countUp(el, to, { duration = 900, format = v => Math.round(v).toLocaleString('ru-RU') } = {}) {
  const from = Number(el.dataset.val || 0);
  el.dataset.val = to;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) { el.textContent = format(to); return; }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / duration);
    const e = 1 - Math.pow(1 - p, 4);
    el.textContent = format(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
