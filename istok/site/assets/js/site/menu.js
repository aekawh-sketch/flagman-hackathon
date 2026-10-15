// ═══════════════════════════════════════════════════════════════
//  Сайт — меню: категории, карточки, поиск, scrollspy, хиты дня
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, num, debounce, norm, plural } from '../../../shared/js/utils.js';
import { icon, toast } from '../../../shared/js/ui.js';
import { photoUrl } from '../../../shared/js/menu-catalog.js';
import { logoMarkup } from '../../../shared/js/logo.js';
import * as S from './state.js';
import * as M from './motion.js';
import { openPicker } from './checkout.js';

const pizzaSize = {};        // id → 0 | 1 (выбор 30/40 см прямо на карточке)
let query = '';
let prevAvail = {};          // id → available (для подсветки изменений)
let spy = null;
let hotSig = '';            // подпись набора хитов — перерисовываем только при изменении

const imgFor = (it, w = 640, h = 480) => it.photo && it.photo !== 'default' ? photoUrl(it.photo, w, h) : '';

function photoHtml(it, w, h) {
  const src = imgFor(it, w, h);
  return src
    ? `<img src="${src}" alt="" loading="lazy" decoding="async" draggable="false">`
    : `<div class="ph">${logoMarkup()}</div>`;
}

// ── Карточка ───────────────────────────────────────────────────
function badgesHtml(it) {
  const stop = it.available === false;
  return [
    it.hot && !stop ? `<span class="badge badge--hot">${icon('flame')}Хит дня</span>` : '',
    it.spicy ? `<span class="badge badge--spicy">Острое</span>` : '',
  ].join('');
}
function cardHtml(it) {
  const stop = it.available === false;
  const hasChoice = !it.pizza && (it.variantOpts || (it.sizes && it.price2));
  const size = pizzaSize[it.id] || 0;
  const price = it.pizza && it.price2 ? (size ? it.price2 : it.price) : it.price;
  const inCart = S.qtyInCart(it.id);
  const badges = badgesHtml(it);
  const sizes = it.pizza && it.price2 && !stop
    ? `<div class="card-sizes" role="radiogroup" aria-label="Размер пиццы">
        <button type="button" class="${size === 0 ? 'on' : ''}" data-size="0" role="radio" aria-checked="${size === 0}">30 см</button>
        <button type="button" class="${size === 1 ? 'on' : ''}" data-size="1" role="radio" aria-checked="${size === 1}">40 см</button>
      </div>` : '';
  const action = stop
    ? `<span class="card-na">${icon('ban')}Нет в наличии</span>`
    : hasChoice
      ? `<button type="button" class="card-choose" data-act="choose" aria-label="Выбрать вариант: ${esc(it.name)}">Выбрать ${icon('chevronRight')}</button>`
      : `<button type="button" class="card-add" data-act="add" aria-label="Добавить в корзину: ${esc(it.name)}">${icon('plus')}</button>`;
  return `
  <article class="card${stop ? ' is-stop' : ''}" data-id="${it.id}" data-cat="${it.cat}">
    ${inCart ? `<span class="card-incart" aria-label="В корзине: ${inCart}">${inCart}</span>` : ''}
    <div class="card-img">
      ${photoHtml(it, 640, 480)}
      <div class="card-badges">${badges}</div>
      ${stop ? `<div class="stop-label"><span>Временно нет</span></div>` : ''}
    </div>
    <div class="card-body">
      <h4 class="card-name">${esc(it.name)}</h4>
      <p class="card-desc">${esc(it.desc || '')}</p>
      ${sizes}
      <div class="card-foot">
        <span class="card-price">${hasChoice ? '<small>от</small>' : ''}${num(price)} ₽</span>
        <span class="card-weight">${esc(it.weight || '')}</span>
        ${action}
      </div>
    </div>
  </article>`;
}

// ── Хиты дня ───────────────────────────────────────────────────
function renderHot() {
  const sec = $('#hot');
  const hot = S.menu.items.filter(i => i.hot && i.available !== false).sort((a, b) => b.hot.priority - a.hot.priority).slice(0, 10);
  const sig = hot.map(h => h.id).join();
  const animate = !hotSig;
  if (sig === hotSig && $('#hotRail').children.length) return;
  hotSig = sig;
  if (!hot.length) { sec.hidden = true; $('#heroHotBtn')?.setAttribute('hidden', ''); return; }
  sec.hidden = false; $('#heroHotBtn')?.removeAttribute('hidden');
  $('#hotRail').innerHTML = hot.map((it, i) => {
    const hasChoice = !it.pizza && (it.variantOpts || (it.sizes && it.price2));
    return `
    <article class="hot-card" data-id="${it.id}" ${animate ? '' : 'data-rev="1"'}>
      ${S.qtyInCart(it.id) ? `<span class="card-incart">${S.qtyInCart(it.id)}</span>` : ''}
      <div class="hot-img">
        ${photoHtml(it, 640, 640)}
        <span class="hot-badge">${icon('flame')}Хит дня</span>
        <span class="hot-rank">${String(i + 1).padStart(2, '0')}</span>
      </div>
      <div class="hot-body">
        <h3 class="hot-name">${esc(it.name)}</h3>
        <p class="hot-why">${icon('sparkles')}${esc(it.hot.reason_public || 'Шеф рекомендует сегодня')}</p>
        <div class="hot-foot">
          <span class="card-price">${hasChoice || it.pizza ? '<small>от</small>' : ''}${num(it.price)} ₽</span>
          ${hasChoice || it.pizza
            ? `<button type="button" class="card-choose" data-act="choose">Выбрать ${icon('chevronRight')}</button>`
            : `<button type="button" class="card-add" data-act="add" aria-label="Добавить: ${esc(it.name)}">${icon('plus')}</button>`}
        </div>
      </div>
    </article>`;
  }).join('');
  M.revealCards($('#hotRail'));
}

// ── Категории ──────────────────────────────────────────────────
function itemsOf(catId) {
  const list = S.menu.items.filter(i => i.cat === catId);
  // доступные сначала, стоп-лист в конце
  return [...list.filter(i => i.available !== false), ...list.filter(i => i.available === false)];
}
function matches(it) {
  if (!query) return true;
  const q = norm(query);
  return norm(it.name).includes(q) || norm(it.desc).includes(q);
}

let activeCat = null;
function renderChips() {
  const cur = activeCat || S.menu.categories[0]?.id;
  $('#chips').innerHTML = S.menu.categories.map(c => {
    const n = S.menu.items.filter(it => it.cat === c.id && matches(it)).length;
    return `<button type="button" class="chip${c.id === cur ? ' on' : ''}" data-cat="${c.id}" ${c.id === cur ? 'aria-current="true"' : ''} ${n ? '' : 'hidden'}>${esc(c.name)} <span class="n">${n}</span></button>`;
  }).join('');
}

export function renderMenu({ animate = true } = {}) {
  const root = $('#menuRoot');
  const cats = S.menu.categories.map(c => ({ ...c, items: itemsOf(c.id).filter(matches) })).filter(c => c.items.length);
  if (!cats.length) {
    root.innerHTML = `<div class="empty menu-empty">${icon('search')}<div class="empty-title">Ничего не нашлось</div><div>Попробуйте другое название — например, «пепперони» или «латте»</div><button class="btn btn--ghost" type="button" id="resetSearch">Сбросить поиск</button></div>`;
    $('#resetSearch').onclick = () => setQuery('');
  } else {
    root.innerHTML = cats.map(c => `
      <section class="menu-cat" id="cat-${c.id}" data-cat="${c.id}" aria-labelledby="h-${c.id}">
        <div class="menu-cat-head">
          <h3 class="menu-cat-title" id="h-${c.id}">${esc(c.name)}</h3>
          <span class="menu-cat-count">${c.items.length}</span>
          <span class="menu-cat-line"></span>
        </div>
        <div class="grid">${c.items.map(cardHtml).join('')}</div>
      </section>`).join('');
  }
  renderChips();
  const found = cats.reduce((s, c) => s + c.items.length, 0);
  $('#menuStatus').textContent = query ? `Найдено: ${found} ${plural(found, ['блюдо', 'блюда', 'блюд'])}` : '';
  if (!animate) $$('.card', root).forEach(c => c.dataset.rev = '1');
  M.revealCards(root);
  setupSpy();
  prevAvail = Object.fromEntries(S.menu.items.map(i => [i.id, i.available !== false]));
}

/** Точечное обновление после смены остатков (без «прыжков» страницы) */
export function patchMenu() {
  const changed = S.menu.items.filter(i => prevAvail[i.id] !== undefined && prevAvail[i.id] !== (i.available !== false));
  const cats = new Set(changed.map(i => i.cat));
  for (const catId of cats) {
    const grid = $(`#cat-${catId} .grid`);
    if (!grid) continue;
    // FLIP: запоминаем положение карточек, перерисовываем и плавно «переезжаем» на новые места
    const before = new Map($$('.card', grid).map(c => [c.dataset.id, c.getBoundingClientRect()]));
    grid.innerHTML = itemsOf(catId).filter(matches).map(cardHtml).join('');
    $$('.card', grid).forEach(c => {
      c.dataset.rev = '1';
      const a = before.get(c.dataset.id);
      if (!a || !M.enabled) return;
      const b = c.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (dx || dy) window.gsap.from(c, { x: dx, y: dy, duration: 0.9, ease: 'power3.inOut', clearProps: 'transform' });
    });
  }
  // бейджи «хит дня» и счётчики корзины обновляем на месте
  $$('#menuRoot .card').forEach(el => {
    const it = S.menu.byId[el.dataset.id];
    if (!it || cats.has(it.cat)) return;
    const b = el.querySelector('.card-badges');
    const want = badgesHtml(it);
    if (b && b.innerHTML !== want) b.innerHTML = want;
  });
  for (const it of changed) {
    const el = $(`#menuRoot .card[data-id="${it.id}"]`);
    if (el && window.gsap) window.gsap.fromTo(el, { boxShadow: '0 0 0 2px var(--brand)' }, { boxShadow: '0 0 0 0px transparent', duration: 1.6, ease: 'power2.out' });
  }
  prevAvail = Object.fromEntries(S.menu.items.map(i => [i.id, i.available !== false]));
  renderChips();
  renderHot();
  setupSpy();
  return changed;
}

export function updateCartBadges() {
  $$('.card, .hot-card').forEach(el => {
    const n = S.qtyInCart(el.dataset.id);
    let b = el.querySelector('.card-incart');
    if (n && !b) { el.insertAdjacentHTML('afterbegin', `<span class="card-incart">${n}</span>`); }
    else if (n && b) b.textContent = n;
    else if (!n && b) b.remove();
  });
}

// ── Scrollspy ──────────────────────────────────────────────────
function setupSpy() {
  spy?.disconnect();
  const chips = $('#chips');
  const setActive = id => {
    if (id === activeCat) return;
    activeCat = id;
    $$('.chip', chips).forEach(c => { const on = c.dataset.cat === id; c.classList.toggle('on', on); on ? c.setAttribute('aria-current', 'true') : c.removeAttribute('aria-current'); });
    const a = $(`.chip[data-cat="${id}"]`, chips);
    if (a) chips.scrollTo({ left: a.offsetLeft - chips.clientWidth / 2 + a.clientWidth / 2, behavior: 'smooth' });
  };
  spy = new IntersectionObserver(entries => {
    const vis = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (vis[0]) setActive(vis[0].target.dataset.cat);
  }, { rootMargin: '-35% 0px -55% 0px' });
  $$('.menu-cat').forEach(s => spy.observe(s));
}

// ── Поиск ──────────────────────────────────────────────────────
function setQuery(q) {
  query = q.trim();
  $('#searchInput').value = q;
  $('#search').classList.toggle('has-value', !!query);
  renderMenu({ animate: false });
  M.refresh();
}

// ── Добавление ─────────────────────────────────────────────────
function addSimple(it, fromEl, size = 0) {
  if (it.available === false) { toast('Это блюдо временно недоступно', { type: 'warn' }); return; }
  if (it.portions_left && S.qtyInCart(it.id) >= it.portions_left) { toast(`Доступно только ${it.portions_left} ${plural(it.portions_left, ['порция', 'порции', 'порций'])}`, { type: 'warn' }); return; }
  S.addToCart(it, { size });
  const img = fromEl?.closest('.card, .hot-card')?.querySelector('img');
  M.flyToCart(img?.src, img || fromEl);
  const name = S.lineName(it, size);
  toast(name, { text: 'Добавлено в корзину', type: 'ok', img: imgFor(it, 120, 120) });
  if (fromEl?.classList.contains('card-add')) {
    fromEl.classList.add('added');
    fromEl.innerHTML = icon('check');
    setTimeout(() => { fromEl.classList.remove('added'); fromEl.innerHTML = icon('plus'); }, 1100);
  }
}

function onGridClick(e) {
  const card = e.target.closest('[data-id]');
  if (!card) return;
  const it = S.menu.byId[card.dataset.id];
  if (!it) return;
  const sizeBtn = e.target.closest('[data-size]');
  if (sizeBtn) {
    pizzaSize[it.id] = Number(sizeBtn.dataset.size);
    $$('[data-size]', card).forEach(b => { const on = b === sizeBtn; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    card.querySelector('.card-price').textContent = `${num(pizzaSize[it.id] ? it.price2 : it.price)} ₽`;
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add') addSimple(it, e.target.closest('[data-act]'), it.pizza ? (pizzaSize[it.id] || 0) : 0);
  else if (act === 'choose') openPicker(it, { onAdd: (size, variant, fromEl) => {
    S.addToCart(it, { size, variant });
    M.flyToCart(imgFor(it, 200, 200), fromEl || card);
    toast(S.lineName(it, size, variant), { text: 'Добавлено в корзину', type: 'ok', img: imgFor(it, 120, 120) });
  } });
  else if (e.target.closest('.card-img, .hot-img') && it.available !== false) {
    // клик по фото — быстрый просмотр
    openPicker(it, { onAdd: (size, variant, fromEl) => {
      S.addToCart(it, { size, variant });
      M.flyToCart(imgFor(it, 200, 200), fromEl || card);
      toast(S.lineName(it, size, variant), { text: 'Добавлено в корзину', type: 'ok', img: imgFor(it, 120, 120) });
    } });
  }
}

// ── Инициализация ──────────────────────────────────────────────
export function initMenu() {
  $('#searchIco').innerHTML = icon('search');
  $('#searchClear').innerHTML = icon('x');
  $('#hotPrev').innerHTML = icon('arrowLeft');
  $('#hotNext').innerHTML = icon('arrowRight');

  // Скелетон до загрузки
  $('#menuRoot').innerHTML = `<div class="grid menu-skeleton" style="margin-top:30px">${Array.from({ length: 8 }, () => `
    <div class="card"><div class="card-img skeleton"></div><div class="card-body"><div class="skeleton" style="height:18px;width:70%"></div><div class="skeleton" style="height:12px;width:90%;margin-top:10px"></div><div class="skeleton" style="height:12px;width:60%;margin-top:6px"></div></div></div>`).join('')}</div>`;

  $('#menuRoot').addEventListener('click', onGridClick);
  $('#hotRail').addEventListener('click', onGridClick);
  M.tilt($('#menuRoot'));
  M.tilt($('#hotRail'), '.hot-card');

  $('#chips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const sec = $(`#cat-${c.dataset.cat}`);
    const off = -(($('#menuToolbar')?.offsetHeight || 60) + 90);
    M.scrollToTarget(sec, off);
  });

  const input = $('#searchInput');
  const search = $('#search');
  search.addEventListener('click', e => { if (e.target.closest('#searchClear')) return; search.classList.add('open'); input.focus(); });
  input.addEventListener('blur', () => { if (!input.value) search.classList.remove('open'); });
  input.addEventListener('input', debounce(() => setQuery(input.value), 180));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { setQuery(''); input.blur(); } });
  $('#searchClear').addEventListener('click', e => { e.stopPropagation(); setQuery(''); input.focus(); });

  // Хиты: перетаскивание мышью + стрелки
  const rail = $('#hotRail');
  let down = null;
  rail.addEventListener('dragstart', e => e.preventDefault());
  rail.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('button')) return;
    down = { x: e.clientX, left: rail.scrollLeft, moved: false, id: e.pointerId };
  });
  rail.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - down.x;
    if (!down.moved && Math.abs(dx) > 5) { down.moved = true; rail.classList.add('dragging'); try { rail.setPointerCapture(down.id); } catch {} }
    if (down.moved) rail.scrollLeft = down.left - dx;
  });
  const endDrag = () => { if (down?.moved) setTimeout(() => rail.classList.remove('dragging'), 0); down = null; };
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);
  rail.addEventListener('lostpointercapture', endDrag);
  const step = () => (rail.querySelector('.hot-card')?.offsetWidth || 300) + 18;
  $('#hotPrev').onclick = () => rail.scrollBy({ left: -step(), behavior: 'smooth' });
  $('#hotNext').onclick = () => rail.scrollBy({ left: step(), behavior: 'smooth' });

  S.on('cart', updateCartBadges);
}

export { renderHot };
