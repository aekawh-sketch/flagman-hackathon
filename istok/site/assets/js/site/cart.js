// ═══════════════════════════════════════════════════════════════
//  Сайт — корзина: панель справа (десктоп) / шторка снизу (мобайл)
// ═══════════════════════════════════════════════════════════════
import { $, esc, money, num, plural } from '../../../shared/js/utils.js';
import { icon, toast } from '../../../shared/js/ui.js';
import { CONFIG } from '../../../shared/js/config.js';
import { photoUrl } from '../../../shared/js/menu-catalog.js';
import { logoMarkup } from '../../../shared/js/logo.js';
import * as S from './state.js';
import * as M from './motion.js';
import { openCheckout } from './checkout.js';

const drawer = () => $('#drawer');
let isOpen = false;
let lastFocus = null;

export function openCart() {
  if (isOpen) return;
  isOpen = true;
  lastFocus = document.activeElement;
  render();
  drawer().inert = false;
  drawer().classList.add('open');
  drawer().setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  M.lockScroll(true);
  setTimeout(() => $('#drawerClose').focus(), 300);
  if (window.gsap && M.enabled) window.gsap.from('#drawerBody .ci', { x: 30, opacity: 0, stagger: 0.04, duration: 0.6, delay: 0.15, ease: 'power3.out' });
}
export function closeCart() {
  if (!isOpen) return;
  isOpen = false;
  drawer().classList.remove('open');
  drawer().style.transform = '';
  drawer().setAttribute('aria-hidden', 'true');
  drawer().inert = true;
  $('#scrim').classList.remove('open');
  M.lockScroll(false);
  lastFocus?.focus?.();
}

function render() {
  const cart = S.getCart();
  const body = $('#drawerBody'), foot = $('#drawerFoot');
  const count = S.cartCount();
  $('#drawerCount').textContent = count ? `${count} ${plural(count, ['позиция', 'позиции', 'позиций'])}` : '';
  if (!cart.length) {
    body.innerHTML = `<div class="cart-empty">${logoMarkup()}<div class="empty-title" style="font-family:var(--font-display);font-size:1.5rem">Здесь пока пусто</div>
      <p class="muted" style="margin:8px 0 20px">Загляните в меню — там много вкусного</p>
      <button class="btn btn--primary" type="button" id="goMenu">Перейти в меню</button></div>`;
    $('#goMenu').onclick = () => { closeCart(); setTimeout(() => M.scrollToTarget('#menu'), 300); };
    foot.hidden = true;
    return;
  }
  body.innerHTML = cart.map(l => {
    const it = S.menu.byId[l.id];
    const stop = it && it.available === false;
    const src = l.photo && l.photo !== 'default' ? photoUrl(l.photo, 160, 160) : '';
    return `<div class="ci${stop ? ' is-stop' : ''}" data-key="${esc(l.key)}">
      <div class="ci-img">${src ? `<img src="${src}" alt="" loading="lazy">` : ''}</div>
      <div>
        <div class="ci-name">${esc(l.name)}</div>
        <div class="ci-price">${money(l.price * l.qty)}</div>
        ${stop ? `<div class="ci-warn">${icon('alert')}Закончилось — уберите из корзины</div>` : ''}
      </div>
      <div class="stepper" role="group" aria-label="Количество">
        <button type="button" data-d="-1" aria-label="${l.qty === 1 ? 'Удалить' : 'Меньше'}">${icon(l.qty === 1 ? 'trash' : 'minus')}</button>
        <output>${l.qty}</output>
        <button type="button" data-d="1" aria-label="Больше">${icon('plus')}</button>
      </div>
    </div>`;
  }).join('');
  const total = S.cartTotal();
  const left = CONFIG.DELIVERY.freeFrom - total;
  const fs = $('#freeShip');
  fs.classList.toggle('done', left <= 0);
  fs.innerHTML = left > 0
    ? `До бесплатной доставки — <b>${money(left)}</b><div class="free-ship-bar"><i style="width:${Math.min(100, total / CONFIG.DELIVERY.freeFrom * 100)}%"></i></div>`
    : `${icon('check')} Доставка бесплатно`;
  fs.querySelector('svg')?.setAttribute('style', 'width:15px;height:15px;display:inline;vertical-align:-3px;margin-right:4px');
  $('#drawerTotal').textContent = money(total);
  foot.hidden = false;
}

function renderBadges() {
  const count = S.cartCount();
  $('#cartCount').textContent = num(count);
  $('#cartCount').hidden = !count;
  $('#fabCount').textContent = num(count);
  $('#fabSum').textContent = money(S.cartTotal());
  const show = count > 0 && !isOpen;
  $('#cartFab').classList.toggle('show', show);
  $('#cartFab').inert = !show;
  document.body.classList.toggle('fab-shown', show && getComputedStyle($('#cartFab')).display !== 'none');
}

export function initCart() {
  $('#cartIco').innerHTML = icon('bag');
  $('#drawerClose').innerHTML = icon('x');
  $('#cartBtn').addEventListener('click', openCart);
  $('#cartFab').addEventListener('click', openCart);
  $('#drawerClose').addEventListener('click', closeCart);
  $('#scrim').addEventListener('click', closeCart);
  addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen && !document.querySelector('dialog[open]')) closeCart(); });
  $('#drawerBody').addEventListener('click', e => {
    const b = e.target.closest('[data-d]');
    if (!b) return;
    const key = b.closest('[data-key]').dataset.key, d = b.dataset.d;
    const line = S.getCart().find(l => l.key === key);
    const max = S.menu.byId[line?.id]?.portions_left;
    if (Number(d) > 0 && max && S.qtyInCart(line.id) >= max) { toast(`Доступно только ${max} шт.`, { type: 'warn' }); return; }
    S.changeQty(key, Number(d));
    // вернуть фокус на ту же кнопку после перерисовки (или на соседнюю строку при удалении)
    const same = [...$('#drawerBody').querySelectorAll('[data-key]')].find(r => r.dataset.key === key);
    (same?.querySelector(`[data-d="${d}"]`) || $('#drawerBody [data-d]') || $('#drawerClose')).focus();
  });
  // Фокус не уходит из открытой корзины
  drawer().addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const f = [...drawer().querySelectorAll('button:not([disabled]), a[href], input')].filter(x => x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  drawer().inert = true;
  addEventListener('resize', renderBadges);
  $('#checkoutBtn').addEventListener('click', () => {
    closeCart();
    setTimeout(openCheckout, 280);
  });

  // Свайп вниз — закрыть шторку на телефоне
  const h = $('#drawerHandle'), dr = drawer();
  let startY = null, dy = 0;
  const startDrag = e => { if (innerWidth >= 760) return; startY = e.touches ? e.touches[0].clientY : e.clientY; dr.classList.add('dragging'); };
  const moveDrag = e => {
    if (startY === null) return;
    dy = Math.max(0, (e.touches ? e.touches[0].clientY : e.clientY) - startY);
    dr.style.transform = `translateY(${dy}px)`;
  };
  const endDrag = () => {
    if (startY === null) return;
    dr.classList.remove('dragging');
    if (dy > 110) closeCart(); else dr.style.transform = '';
    startY = null; dy = 0;
  };
  h.addEventListener('touchstart', startDrag, { passive: true });
  $('.drawer-head').addEventListener('touchstart', startDrag, { passive: true });
  addEventListener('touchmove', moveDrag, { passive: true });
  addEventListener('touchend', endDrag);

  S.on('cart', () => { renderBadges(); if (isOpen) render(); });
  S.on('menu', () => { if (isOpen) render(); });
  const fabSync = new MutationObserver(renderBadges);
  fabSync.observe(dr, { attributes: true, attributeFilter: ['class'] });
  renderBadges();
}
