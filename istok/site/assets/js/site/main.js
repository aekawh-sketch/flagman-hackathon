// ═══════════════════════════════════════════════════════════════
//  ИСТОК — сайт: точка входа
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, debounce, plural, num } from '../../../shared/js/utils.js';
import { icon, toast, themeToggleButton, wireThemeToggles, createModal, openModal, closeModal } from '../../../shared/js/ui.js';
import { mountLogos, logoMarkup } from '../../../shared/js/logo.js';
import { api, resolveMode } from '../../../shared/js/api.js';
import { subscribe } from '../../../shared/js/realtime.js';
import { CONFIG } from '../../../shared/js/config.js';
import { photoUrl } from '../../../shared/js/menu-catalog.js';
import * as S from './state.js';
import * as M from './motion.js';
import { initMenu, renderMenu, patchMenu, renderHot } from './menu.js';
import { initCart } from './cart.js';
import { initTracking } from './tracking.js';

// ── Статичные части страницы ───────────────────────────────────
function mountStatic() {
  mountLogos();
  $('#themeSlot').outerHTML = themeToggleButton();
  wireThemeToggles();
  $$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  $$('.i-arrow').forEach(el => { el.outerHTML = icon('arrowRight'); });
  $$('img[data-photo]').forEach(img => { img.src = photoUrl(img.dataset.photo, 520, 520); });
  $('#year').textContent = new Date().getFullYear();

  const words = ['Бургеры', 'Пицца из печи', 'Роллы', 'Боул и поке', 'Авторские напитки', 'Всё начинается со вкуса'];
  const row = words.map(w => `<span class="marquee-item">${esc(w)} ${logoMarkup()}</span>`).join('');
  $('#marquee').innerHTML = row + row;

  // Фото не загрузилось — брендовая заглушка вместо пустого места
  document.addEventListener('error', e => {
    const img = e.target;
    if (img?.tagName !== 'IMG' || !img.closest('.card-img, .hot-img, .ci-img, .picker-img, .hero-float')) return;
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.innerHTML = logoMarkup();
    img.replaceWith(ph);
  }, true);

  // Плавные якоря
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-scroll]');
    if (!a) return;
    const id = a.getAttribute('href');
    if (!id?.startsWith('#')) return;
    e.preventDefault();
    if (id === '#top') M.scrollToTarget(document.body, 0);
    else M.scrollToTarget(id, id === '#menu' ? -70 : -60);
  });
}

// ── Город: шапка, hero, подвал ─────────────────────────────────
function renderLocation() {
  const L = S.locInfo();
  const btn = $('#locBtn');
  btn.innerHTML = `${icon('pin')}<span>${esc(L ? L.city : 'Выбрать город')}</span>`;
  const info = L || Object.values(CONFIG.LOCATIONS)[0];
  // Статус «Готовим / Закрыто» по часам работы точки
  const h = new Date().getHours();
  const isOpen = h >= (info.open ?? 0) && h < (info.close ?? 24);
  const live = $('#heroLive');
  live.textContent = isOpen ? 'Готовим' : `Закрыто до ${String(info.open).padStart(2, '0')}:00`;
  live.classList.toggle('closed', !isOpen);
  $('#heroEyebrow').innerHTML = L
    ? `Доставка в <button type="button" id="heroCity" aria-label="Сменить город">${esc(L.cityIn)}</button> за ${CONFIG.DELIVERY.eta}`
    : `Доставка за ${CONFIG.DELIVERY.eta}`;
  $('#heroCity')?.addEventListener('click', () => openLocationPicker());
  $('#heroMeta').innerHTML = `
    <span>${icon('star')}<b>${esc(info.rating)}</b> · ${esc(info.reviews)}</span>
    <span>${icon('clock')}${esc(info.hours)}</span>
    <span>${icon('scooter')}Бесплатно от <b>${num(CONFIG.DELIVERY.freeFrom)} ₽</b></span>`;
  const fp = $('#footerPhone');
  fp.href = `tel:${info.phoneTel}`;
  fp.innerHTML = `${icon('phone')} ${esc(info.phone)}`;
  $('#footerCols').innerHTML = Object.values(CONFIG.LOCATIONS).map(l => `
    <div><div class="footer-h">${esc(l.name)}</div>
      <p class="footer-p">${esc(l.street)}<br><a href="tel:${l.phoneTel}">${esc(l.phone)}</a><br>${esc(l.hours)}</p></div>`).join('') + `
    <div><div class="footer-h">Доставка</div>
      <p class="footer-p">${CONFIG.DELIVERY.eta}<br>До ${num(CONFIG.DELIVERY.freeFrom)} ₽ — ${CONFIG.DELIVERY.fee} ₽<br>От ${num(CONFIG.DELIVERY.freeFrom)} ₽ — бесплатно</p></div>
    <div><div class="footer-h">Оплата</div>
      <p class="footer-p">Картой или наличными<br>Самовывоз — бесплатно</p></div>`;
}

function openLocationPicker({ force = false } = {}) {
  if (document.querySelector('dialog.loc-picker[open]')) return;
  const d = createModal(`
    <div class="modal-head">
      <div style="flex:1"><h2 class="modal-title">Где вы?</h2><p class="modal-sub">Покажем меню и наличие блюд в вашей точке</p></div>
      ${force ? '' : `<button class="modal-close" type="button" data-close aria-label="Закрыть">${icon('x')}</button>`}
    </div>
    <div class="modal-body"><div class="loc-cards">
      ${Object.values(CONFIG.LOCATIONS).map(l => `
        <button class="loc-card" type="button" data-loc="${l.code}">
          <span class="lc-ico">${icon('pin')}</span>
          <span><b>${esc(l.name)}</b><span>${esc(l.street)} · ${esc(l.hours)}</span></span>
          ${icon('arrowRight')}
        </button>`).join('')}
    </div></div>`, { className: 'loc-picker' });
  d.style.maxWidth = '460px';
  d.addEventListener('click', e => {
    const b = e.target.closest('[data-loc]');
    if (b) { S.setLoc(b.dataset.loc); closeModal(d); }
  });
  if (force) {
    // без выбора города закрыть нельзя (Esc и клик по подложке игнорируются)
    d.addEventListener('cancel', e => { if (!S.getLoc()) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    d.addEventListener('click', e => { if (e.target === d && !S.getLoc()) e.stopImmediatePropagation(); }, true);
  }
  d.addEventListener('closed', () => {
    d.remove();
    M.lockScroll(false);
    // браузер всё-таки закрыл окно нативно (Esc без взаимодействия) — открываем снова
    if (force && !S.getLoc()) setTimeout(() => openLocationPicker({ force: true }), 50);
  });
  M.lockScroll(true);
  openModal(d);
}

// ── Загрузка меню + обновления в реальном времени ──────────────
let unsub = null;
let subGen = 0;
let firstLoad = true;

let menuGen = 0;
async function loadMenu({ patch = false } = {}) {
  const my = ++menuGen;
  const loc = S.getLoc() || Object.keys(CONFIG.LOCATIONS)[0];
  try {
    const data = await api.menu(loc);
    if (my !== menuGen) return;          // пока грузили, город сменился
    const before = S.unavailableInCart().map(l => l.key);
    S.setMenu(data);
    if (patch && !firstLoad) {
      const changed = patchMenu();
      const nowStop = S.unavailableInCart().filter(l => !before.includes(l.key));
      if (nowStop.length) toast('Блюдо из корзины закончилось', { type: 'warn', text: nowStop.map(l => l.name).join(', ') });
      else if (changed.some(i => i.available === false)) toast('Меню обновилось', { type: 'info', text: 'Некоторые блюда временно недоступны', icon: 'refresh' });
    } else {
      renderMenu({ animate: true });
      renderHot();
    }
    firstLoad = false;
    const stopN = data.items.filter(i => i.available === false).length;
    $('#menuLead').textContent = `${data.items.length} ${plural(data.items.length, ['позиция', 'позиции', 'позиций'])}: бургеры, пицца, роллы, супы и напитки.`;
    M.refresh();
  } catch (e) {
    console.error(e);
    if (firstLoad) { renderMenu({ animate: true }); firstLoad = false; }
    toast('Не удалось обновить меню', { type: 'err', text: e.message });
  }
}

const refreshMenu = debounce(() => loadMenu({ patch: true }), 400);

async function listen() {
  unsub?.();
  unsub = null;
  const my = ++subGen;
  const loc = S.getLoc();
  if (!loc) return;
  const off = await subscribe(loc, ev => {
    if (['stock.changed', 'stoplist.changed', 'supply.received', 'writeoff.created', 'order.created', 'tick'].includes(ev.type)) refreshMenu();
  }, { withCredentials: false });
  if (my !== subGen) off();          // пока ждали — город сменился, эта подписка уже не нужна
  else unsub = off;
}

async function showMode() {
  const mode = await resolveMode();
  const pill = $('#modePill');
  pill.className = `mode-pill ${mode}`;
  pill.querySelector('span').textContent = mode === 'real' ? 'Сервер онлайн' : 'Демо-режим (данные в браузере)';
}

// ── Старт ──────────────────────────────────────────────────────
async function start() {
  mountStatic();
  renderLocation();
  initMenu();
  initCart();
  initTracking();
  M.initSmoothScroll();
  M.headerBehavior();
  M.magnetic();
  showMode();

  $('#locBtn').addEventListener('click', () => openLocationPicker());
  S.on('loc', () => { renderLocation(); firstLoad = true; loadMenu(); listen(); });
  S.on('refresh-menu', refreshMenu);

  const menuReady = loadMenu();
  await M.preloader();
  M.heroIntro();
  M.marquee();
  M.scrollReveals();
  M.magnetic();
  await menuReady;
  M.refresh();
  listen();

  if (!S.getLoc()) setTimeout(() => openLocationPicker({ force: true }), M.enabled ? 900 : 200);
}

start();
