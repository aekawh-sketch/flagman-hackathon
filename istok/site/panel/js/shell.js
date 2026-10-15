// ═══════════════════════════════════════════════════════════════
//  ИСТОК — каркас панели: вход, сайдбар, топбар, live-индикатор
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, store } from '../../shared/js/utils.js';
import { icon, themeToggleButton, wireThemeToggles, toast } from '../../shared/js/ui.js';
import { logoMarkup, logoLockup, mountLogos } from '../../shared/js/logo.js';
import { api, resolveMode } from '../../shared/js/api.js';
import { subscribe } from '../../shared/js/realtime.js';
import { enhanceSelect } from '../../shared/js/picker.js';
import { CONFIG } from '../../shared/js/config.js';

// Роли — из Флагмана: админ заводит сотрудника там, и тот входит сюда своим логином и паролем.
// Сервер проверяет те же права (server.js, ROLES) — здесь только чтобы не показывать лишнее.
// Заказы пробивает только кассир (ТЗ 16): управляющему и админу касса закрыта.
const ALL = ['CASHIER', 'COOK', 'STOREKEEPER', 'MANAGER', 'ADMIN'];
export const PAGES = [
  { id: 'kassir',     href: 'kassir.html',     title: 'Касса',       icon: 'cash',      section: 'Операции', desc: 'Столы, самовывоз, доставка, оплата', roles: ['CASHIER'] },
  { id: 'ofick',      href: 'ofick.html',      title: 'Заказы',      icon: 'chef',      section: 'Операции', desc: 'Кухня, статусы, выдача', roles: ['CASHIER', 'COOK', 'MANAGER', 'ADMIN'] },
  { id: 'courier',    href: 'courier.html',    title: 'Курьер',      icon: 'scooter',   section: 'Операции', desc: 'Доставки и маршруты', roles: ['CASHIER', 'MANAGER', 'ADMIN'] },
  { id: 'spisanie',   href: 'spisanie.html',   title: 'Списание',    icon: 'trash',     section: 'Операции', desc: 'Порча, бой, пролитый напиток — с фото и PIN', roles: ALL },
  { id: 'accounting', href: 'accounting.html', title: 'Бухгалтерия', icon: 'bars',      section: 'Управление', desc: 'Выручка, отчёты, экспорт', roles: ['MANAGER', 'ADMIN'] },
];

export const ROLE_RU = { CASHIER: 'Кассир', COOK: 'Повар', STOREKEEPER: 'Кладовщик', MANAGER: 'Управляющий', ADMIN: 'Админ' };
/** Разделы, доступные сотруднику; служебный вход — все. */
export const pagesFor = user => PAGES.filter(p => user?.service || p.roles.includes(user?.role));
/** Управляющему и админу — бухгалтерия и очистка заказов. */
export const canManage = user => !!user && (user.service || ['MANAGER', 'ADMIN'].includes(user.role));

/** Точка страницы: из адреса, если человек в ней работает, иначе — выбранная при входе. */
export function currentLoc(user) {
  const q = new URLSearchParams(location.search).get('loc');
  return q && user.places.some(p => p.id === q) ? q : user.loc;
}

/**
 * Точка для страниц: у ИСТОК — из конфига сайта (адрес, город), у другого ресторана — название со склада.
 * label — подпись в заголовках и именах файлов.
 */
export function placeOf(user, loc) {
  const own = CONFIG.LOCATIONS[loc];
  if (user.own && own) return { ...own, label: `ИСТОК · ${own.city}` };
  const name = user.places.find(p => p.id === loc)?.name || loc;
  return { code: loc, name, city: name, cityIn: name, addrPrefix: '', street: '', label: `${user.tenantName} · ${name}` };
}

/**
 * Инициализация страницы панели.
 * @returns {Promise<{loc, L, live, setBadge, setTitle}>}
 */
export async function initShell({ page, title, subtitle = '' }) {
  document.body.insertAdjacentHTML('afterbegin', `<div class="boot" id="boot">${logoMarkup()}</div>`);

  // Проверка входа: человек вошёл и выбрал место работы (ресторан и точку)
  const user = await api.authCheck();
  if (!user) {
    location.replace(`login.html?back=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`);
    return new Promise(() => {});            // дальше не идём
  }
  // Точка не из места работы — в свою; раздел не по роли — в первый доступный
  const loc = currentLoc(user);
  const q = new URLSearchParams(location.search).get('loc');
  if (q && q !== loc) {
    location.replace(`${location.pathname.split('/').pop()}?loc=${loc}`);
    return new Promise(() => {});
  }
  const L = placeOf(user, loc);
  store.set('istok_panel_loc', loc);
  const allowed = pagesFor(user);
  if (!allowed.some(p => p.id === page)) {
    location.replace(allowed.length ? `${allowed[0].href}?loc=${loc}` : 'login.html');
    return new Promise(() => {});
  }

  document.title = `${title} — ${L.label}`;
  renderSidebar(page, loc, user);
  renderTopbar(title, subtitle || L.name);
  wireThemeToggles();
  mountLogos();
  startClock();
  showMode();

  document.body.classList.remove('booting');
  const boot = $('#boot');
  boot.classList.add('out');
  setTimeout(() => boot.remove(), 400);

  const badges = {};
  return {
    loc, L, user,
    /** Подписка на события точки; индикатор «Live» в топбаре */
    live: async handler => {
      const el = $('#tbLive');
      try {
        const off = await subscribe(loc, ev => { el.className = 'tb-live on'; handler(ev); });
        el.className = 'tb-live on';
        el.querySelector('span').textContent = 'Live';
        return off;
      } catch {
        el.className = 'tb-live off';
        el.querySelector('span').textContent = 'Нет связи';
        return () => {};
      }
    },
    setLiveError: (isErr) => {
      const el = $('#tbLive');
      el.className = `tb-live ${isErr ? 'off' : 'on'}`;
      el.querySelector('span').textContent = isErr ? 'Нет связи' : 'Live';
    },
    setBadge: (pageId, n, kind = '') => {
      const a = $(`.sb-link[data-page="${pageId}"]`);
      if (!a) return;
      let b = a.querySelector('.sb-count');
      if (!n) { b?.remove(); return; }
      if (!b) { b = document.createElement('i'); a.appendChild(b); }
      b.className = `sb-count ${kind}`;
      b.textContent = n > 99 ? '99+' : n;
      badges[pageId] = n;
    },
    setTitle: (t, sub) => { $('#tbTitle').textContent = t; if (sub !== undefined) $('#tbCrumb').textContent = sub; },
  };
}

function renderSidebar(active, loc, user) {
  const sb = $('#sidebar');
  let section = '';
  const links = pagesFor(user).map(p => {
    const head = p.section !== section ? `<div class="sb-section">${esc((section = p.section))}</div>` : '';
    return `${head}<a class="sb-link${p.id === active ? ' active' : ''}" data-page="${p.id}" href="${p.href}?loc=${loc}" ${p.id === active ? 'aria-current="page"' : ''} title="${esc(p.title)}">${icon(p.icon)}<span>${esc(p.title)}</span></a>`;
  }).join('');
  // Точки — только этого места работы; другой ресторан — через «Сменить место работы»
  const places = user.places.map(p => ({ id: p.id, name: placeOf(user, p.id).name }));
  sb.innerHTML = `
    <a class="sb-brand" ${user.own ? 'href="../index.html" title="Открыть сайт"' : `href="login.html" title="${esc(user.tenantName)}"`}>${logoLockup({ sub: user.own ? 'Панель' : user.tenantName })}</a>
    <label class="sb-loc" title="Точка">${icon('pin')}
      <select id="sbLoc" aria-label="Точка" ${places.length < 2 ? 'disabled title="Вы работаете в этой точке"' : ''}>${places.map(p => `<option value="${esc(p.id)}" ${p.id === loc ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    </label>
    ${links}
    <div class="sb-spacer"></div>
    <div class="sb-foot">
      <div class="sb-mode" title="${esc(user.service ? 'Служебный вход владельца' : `Логин во Флагмане: ${user.login}`)}">${icon('user')}<span><b style="color:var(--text)">${esc(user.name)}</b> · ${esc(user.service ? 'служебный' : (ROLE_RU[user.role] || user.role))}</span></div>
      <div class="sb-mode" id="sbMode"><i></i><span>Проверка…</span></div>
      ${user.multi ? `<a class="sb-link" href="login.html?step=place" title="Другой ресторан или точка">${icon('pin')}<span>Сменить место работы</span></a>` : ''}
      ${user.own ? `<a class="sb-link" href="../index.html" target="_blank" rel="noopener" title="Открыть сайт">${icon('store')}<span>Сайт</span></a>` : ''}
      <button class="sb-link" type="button" id="sbLogout" title="Выйти">${icon('logout')}<span>Выйти</span></button>
    </div>`;
  enhanceSelect($('#sbLoc'), { bare: true, search: false });
  $('#sbLoc').addEventListener('change', e => {
    const u = new URL(location.href);
    u.searchParams.set('loc', e.target.value);
    location.href = u.toString();
  });
  $('#sbLogout').addEventListener('click', async () => {
    try { await api.logout(); } catch {}
    location.href = 'login.html';
  });
}

function renderTopbar(title, sub) {
  $('#topbar').innerHTML = `
    <div style="min-width:0;display:flex;align-items:baseline;gap:12px">
      <h1 class="tb-title" id="tbTitle">${esc(title)}</h1>
      <span class="tb-crumb" id="tbCrumb">${esc(sub)}</span>
    </div>
    <div class="tb-spacer"></div>
    <span class="tb-live" id="tbLive" title="Обновления в реальном времени"><i></i><span>Подключение…</span></span>
    <span class="tb-clock" id="tbClock"></span>
    ${themeToggleButton()}`;
}

function startClock() {
  const el = $('#tbClock');
  const tick = () => { el.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick();
  setInterval(tick, 1000);
}

async function showMode() {
  const mode = await resolveMode();
  const el = $('#sbMode');
  el.className = `sb-mode ${mode}`;
  el.querySelector('span').textContent = mode === 'real' ? 'Сервер подключён' : 'Демо-данные';
  el.title = mode === 'real' ? CONFIG.API_BASE : 'Бэкенд недоступен — работаем на демо-данных в браузере';
}

/** Звуковой сигнал (Web Audio, без файлов) */
export function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[660, 0, 0.12], [880, 0.14, 0.14], [990, 0.3, 0.2]].forEach(([f, s, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.18, ctx.currentTime + s);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + s + d);
      o.start(ctx.currentTime + s); o.stop(ctx.currentTime + s + d + 0.05);
    });
  } catch {}
}

/** Боковая панель (sheet) */
export function openSheet(html, { onClose } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const sh = document.createElement('aside');
  sh.className = 'sheet';
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.innerHTML = html;
  document.body.append(scrim, sh);
  requestAnimationFrame(() => { scrim.classList.add('open'); sh.classList.add('open'); });
  const close = () => {
    scrim.classList.remove('open'); sh.classList.remove('open');
    removeEventListener('keydown', esc_);
    setTimeout(() => { scrim.remove(); sh.remove(); onClose?.(); }, 450);
  };
  const esc_ = e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
  addEventListener('keydown', esc_);
  scrim.addEventListener('click', close);
  sh.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  setTimeout(() => sh.querySelector('input, select, button:not([data-close])')?.focus(), 350);
  return { el: sh, close };
}

export { toast };
