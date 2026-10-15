// ═══════════════════════════════════════════════════════════════
//  Панель — КАССА (планшет): столы, самовывоз, доставка, оплата
//  Открытые столы хранятся локально (как в старой кассе);
//  на сервер уходит каждый «раунд» заказа: POST /cashier или /order.
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, num, money, bindPhoneMask, phoneDigits, plural, elapsed, store, debounce, norm } from '../../shared/js/utils.js';
import { icon, toast, confirmDialog, createModal, openModal, closeModal } from '../../shared/js/ui.js';
import { api } from '../../shared/js/api.js';
import { CONFIG, DONE_STATUSES } from '../../shared/js/config.js';
import { initShell } from './shell.js';

const shell = await initShell({ page: 'kassir', title: 'Касса' });
const { loc, L } = shell;
const KEY = `istok_pos_${loc}`;
const CAT_COLORS = { burgers: '#E2603F', notburgers: '#F2B33D', snacks: '#8BC34A', salads: '#3FB37F', soups: '#E5484D', pizza: '#EC4899', rolls_cold: '#5B9CF5', rolls_hot: '#A78BFA', sets: '#FB923C', mains: '#B08968', drinks: '#22D3EE' };
const TABLES = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: `t${i + 1}`, name: `Стол ${i + 1}`, zone: 'hall' })),
  ...Array.from({ length: 8 }, (_, i) => ({ id: `t${i + 11}`, name: `Стол ${i + 11}`, zone: 'terrace' })),
];

// ── Состояние ──────────────────────────────────────────────────
const st = Object.assign({ open: {}, seqTake: 0, seqDel: 0, done: [] }, store.get(KEY, {}));
const save = () => store.set(KEY, { ...st, done: st.done.slice(-100) });
let menu = { categories: [], items: [], byId: {} };
// «Осталось N» после корзины: ответ склада по позициям и корзина, на которую он посчитан
let left = null, leftCounts = {}, leftSeq = 0;
let activeId = null, catIdx = 0, query = '', doneFilter = 'all';

const guestWord = n => plural(n, ['гость', 'гостя', 'гостей']);
const cartOf = o => o.guestCarts[o.activeGuest] || [];
const newTotal = o => o.guestCarts.flat().reduce((s, l) => s + l.price * l.qty, 0);
const sentTotal = o => o.rounds.reduce((s, r) => s + r.total, 0);
const allLines = o => [...o.rounds.flatMap(r => r.items), ...o.guestCarts.flat()];

// ═══════════════════════════════════════════════════════════════
//  МЕНЮ
// ═══════════════════════════════════════════════════════════════
async function loadMenu() {
  try {
    const d = await api.menu(loc);
    menu = { categories: d.categories, items: d.items, byId: Object.fromEntries(d.items.map(i => [i.id, i])) };
    if (activeId) renderGrid();
  } catch (e) { toast('Меню не загрузилось', { type: 'err', text: e.message }); }
}

// ═══════════════════════════════════════════════════════════════
//  СКОЛЬКО ОСТАЛОСЬ: склад вычитает корзину по продуктам, поэтому
//  два ролла уменьшают и поке на том же лососе. Пока ответ в пути —
//  прошлый ответ минус нажатия, сделанные после него.
// ═══════════════════════════════════════════════════════════════
const sizeIdx = (it, l) => (it?.variantOpts ? Number(l.variant) || 0 : Number(l.size) || 0);
function cartCounts() {
  const o = st.open[activeId];
  const out = {};
  (o ? o.guestCarts.flat() : []).forEach(l => {
    const k = `${l.id}|${sizeIdx(menu.byId[l.id], l)}`;
    out[k] = (out[k] || 0) + l.qty;
  });
  return out;
}

/** Сколько ещё можно пробить размера idx; без idx — лучший из размеров. null — склад позицию не считает. */
function leftOf(it, idx) {
  const info = left ? left[it.id] : it.stock;
  if (!info) return null;
  const base = left ? leftCounts : {};
  const now = cartCounts();
  const per = info.variants.map((n, i) => (n === null ? null
    : Math.max(0, n - ((now[`${it.id}|${i}`] || 0) - (base[`${it.id}|${i}`] || 0)))));
  if (idx !== undefined) return per[Math.min(idx, per.length - 1)] ?? null;
  const counted = per.filter(n => n !== null);
  return counted.length ? Math.max(...counted) : null;
}

async function refreshLeft() {
  const o = st.open[activeId];
  const lines = o ? o.guestCarts.flat().map(l => ({ id: l.id, size: l.size, variant: l.variant, qty: l.qty })) : [];
  const seq = ++leftSeq;
  if (!lines.length) { left = null; leftCounts = {}; return rerender(); }
  const counts = cartCounts();
  try {
    const r = await api.menuLeft(loc, lines);
    if (seq !== leftSeq) return;                       // пока ждали, корзину уже поменяли
    left = r.left; leftCounts = counts;
    rerender();
  } catch { /* склад недоступен — касса работает по меню, без счётчика корзины */ }
}
const refreshLeftSoon = debounce(refreshLeft, 120);
function rerender() { if ($('#posItems')) { renderGrid(); renderOrder(); } }

const leftLabel = n => (n === 0 ? 'больше нет' : n === 1 ? 'последняя порция' : `осталось ${n}`);
const leftClass = n => (n <= 1 ? ' last' : n <= 3 ? '' : ' ok');
function noMore(it) {
  toast(`${it.name}: больше нет`, { type: 'warn', text: 'Всё, что пропустит склад, уже в этом заказе — предложите гостю другое' });
}

// ═══════════════════════════════════════════════════════════════
//  ЭКРАН СТОЛОВ
// ═══════════════════════════════════════════════════════════════
function renderTables() {
  activeId = null;
  shell.setTitle('Касса', L.name);
  const c = $('#content');
  c.style.padding = '';
  const open = Object.values(st.open);
  const card = t => {
    const o = st.open[t.id];
    if (!o) return `<button class="tcard free" type="button" data-new-table="${t.id}">${icon('plus')}<b>${esc(t.name)}</b></button>`;
    const lines = allLines(o);
    return `<button class="tcard busy" type="button" data-open="${o.id}">
      <span class="t-name">${esc(t.name)}</span><span class="t-meta">${o.guests} ${guestWord(o.guests)} · ${elapsed(o.startTime)}</span>
      <span class="t-items">${lines.slice(0, 4).map(l => `${esc(l.name)}${l.qty > 1 ? ' ×' + l.qty : ''}`).join(', ') || '<span class="faint">пусто</span>'}</span>
      <span class="t-sum">${money(sentTotal(o) + newTotal(o))}</span></button>`;
  };
  const listCard = o => {
    const lines = allLines(o);
    const status = o.serverStatus;
    return `<button class="tcard busy" type="button" data-open="${o.id}">
      <span class="t-name">${esc(o.name)}</span>
      <span class="t-meta">${o.type === 'delivery' ? esc(o.address) : o.phone ? esc(o.phone) : 'без телефона'} · ${elapsed(o.startTime)}</span>
      <span class="t-items">${lines.slice(0, 3).map(l => esc(l.name)).join(', ') || '<span class="faint">пусто</span>'}</span>
      <span style="display:flex;align-items:center;justify-content:space-between;gap:6px"><span class="t-sum">${money(sentTotal(o) + newTotal(o))}</span>${status ? `<span class="st ${status === CONFIG.STATUS.ON_WAY ? 'st-way' : status === CONFIG.STATUS.READY ? 'st-ready' : 'st-cook'}">${esc(status)}</span>` : ''}</span></button>`;
  };
  const df = st.done.filter(d => doneFilter === 'all' || d.payment === doneFilter).slice().reverse();
  c.innerHTML = `
    <div class="page-head">
      <div><h1>Касса</h1><p>${open.length ? `Открыто: ${open.length}` : 'Все столы свободны'} · выручка смены ${money(st.done.filter(d => d.status !== 'cancelled').reduce((s, d) => s + d.total, 0))}</p></div>
      <div class="actions">
        <button class="btn btn--ghost" type="button" data-new-take>${icon('bag')} Самовывоз</button>
        <button class="btn btn--primary" type="button" data-new-del>${icon('scooter')} Доставка</button>
      </div>
    </div>
    <section class="zone"><div class="zone-h"><h2>Зал</h2><span class="pill">10 столов</span></div><div class="tables">${TABLES.filter(t => t.zone === 'hall').map(card).join('')}</div></section>
    <section class="zone"><div class="zone-h"><h2>Летняя веранда</h2><span class="pill">8 столов</span></div><div class="tables">${TABLES.filter(t => t.zone === 'terrace').map(card).join('')}</div></section>
    <section class="zone"><div class="zone-h"><h2>Самовывоз</h2></div><div class="tables">
      <button class="tcard new" type="button" data-new-take>${icon('plus')} Новый самовывоз</button>${open.filter(o => o.type === 'take').map(listCard).join('')}</div></section>
    <section class="zone"><div class="zone-h"><h2>Доставки</h2></div><div class="tables">
      <button class="tcard new" type="button" data-new-del>${icon('plus')} Новая доставка</button>${open.filter(o => o.type === 'delivery').map(listCard).join('')}</div></section>
    ${st.done.length ? `<section class="zone"><div class="zone-h"><h2>Завершённые</h2><span class="pill">${st.done.length}</span><span style="flex:1"></span>
      ${[['all', 'Все'], ['card', 'Карта'], ['cash', 'Наличные']].map(([k, t]) => `<button class="chip chip-sm${doneFilter === k ? ' on' : ''}" type="button" data-df="${k}">${t}</button>`).join('')}</div>
      <div class="tables">${df.map(d => `<div class="tcard" style="cursor:default;min-height:auto${d.status === 'cancelled' ? ';opacity:.55' : ''}"><span class="t-name">№ ${esc(d.orderNumber)} · ${esc(d.tableName)}</span><span class="t-meta">${esc(d.time)} · ${d.payment === 'card' ? 'карта' : 'наличные'}${d.status === 'cancelled' ? ' · отменён' : ''}</span><span class="t-items">${d.items.slice(0, 3).map(l => esc(l.name)).join(', ')}</span><span class="t-sum">${money(d.total)}</span></div>`).join('')}</div></section>` : ''}`;
}

$('#content').addEventListener('click', e => {
  if (activeId) return;
  const t = e.target.closest('[data-new-table]'); if (t) return setupTable(t.dataset.newTable);
  if (e.target.closest('[data-new-take]')) return setupTake();
  if (e.target.closest('[data-new-del]')) return setupDelivery();
  const o = e.target.closest('[data-open]'); if (o) return openOrder(o.dataset.open);
  const df = e.target.closest('[data-df]'); if (df) { doneFilter = df.dataset.df; renderTables(); }
});

// ── Открытие заказов ───────────────────────────────────────────
function makeOrder(o) {
  return { activeGuest: 0, guests: 1, rounds: [], startTime: Date.now(), comment: '', ...o, guestCarts: Array.from({ length: o.guests || 1 }, () => []), guestPay: Array.from({ length: o.guests || 1 }, () => o.payment || 'cash') };
}

function setupTable(tid) {
  const t = TABLES.find(x => x.id === tid);
  let g = 2;
  const d = createModal(`
    <div class="modal-head"><div style="flex:1"><h2 class="modal-title">${esc(t.name)}</h2><p class="modal-sub">${t.zone === 'hall' ? 'Зал' : 'Летняя веранда'} · сколько гостей?</p></div><button class="modal-close" type="button" data-close>${icon('x')}</button></div>
    <div class="modal-body" style="display:flex;align-items:center;justify-content:center;gap:22px;padding:20px">
      <button class="btn btn--ghost btn--icon btn--lg" type="button" data-g="-1" aria-label="Меньше">${icon('minus')}</button>
      <div style="text-align:center;min-width:110px"><div id="gN" style="font-family:var(--font-display);font-size:4rem;font-weight:700;line-height:1">2</div><div class="muted" id="gW">гостя</div></div>
      <button class="btn btn--ghost btn--icon btn--lg" type="button" data-g="1" aria-label="Больше">${icon('plus')}</button>
    </div>
    <div class="modal-foot"><button class="btn btn--primary btn--lg btn--block" type="button" id="gGo">Открыть стол ${icon('arrowRight')}</button></div>`);
  d.style.maxWidth = '420px';
  d.addEventListener('click', e => { const b = e.target.closest('[data-g]'); if (!b) return; g = Math.max(1, Math.min(20, g + Number(b.dataset.g))); $('#gN', d).textContent = g; $('#gW', d).textContent = guestWord(g); });
  $('#gGo', d).onclick = () => { st.open[tid] = makeOrder({ id: tid, name: t.name, type: 'dine', zone: t.zone, guests: g }); save(); closeModal(d); openOrder(tid); };
  d.addEventListener('closed', () => d.remove());
  openModal(d);
}

function setupTake() {
  const d = createModal(`
    <div class="modal-head"><div style="flex:1"><h2 class="modal-title">Самовывоз</h2><p class="modal-sub">Телефон нужен, чтобы сообщить о готовности</p></div><button class="modal-close" type="button" data-close>${icon('x')}</button></div>
    <div class="modal-body"><label class="field"><span class="field-label">Телефон клиента</span><input class="input" id="tkPhone" type="tel" inputmode="tel" placeholder="+7 (000) 000-00-00"></label></div>
    <div class="modal-foot"><button class="btn btn--primary btn--lg btn--block" type="button" id="tkGo">К выбору блюд ${icon('arrowRight')}</button></div>`);
  d.style.maxWidth = '440px';
  const p = $('#tkPhone', d);
  bindPhoneMask(p);
  $('#tkGo', d).onclick = () => {
    st.seqTake++;
    const id = `to_${Date.now().toString(36)}`;
    st.open[id] = makeOrder({ id, name: `Самовывоз #${st.seqTake}`, type: 'take', zone: 'take', phone: p.value });
    save(); closeModal(d); openOrder(id);
  };
  d.addEventListener('closed', () => d.remove());
  openModal(d);
  setTimeout(() => p.focus(), 200);
}

function setupDelivery() {
  let pay = 'cash';
  const d = createModal(`
    <div class="modal-head"><div style="flex:1"><h2 class="modal-title">Новая доставка</h2><p class="modal-sub">Данные клиента</p></div><button class="modal-close" type="button" data-close>${icon('x')}</button></div>
    <form class="modal-body form-grid" id="dlForm" novalidate style="display:grid;gap:14px">
      <label class="field"><span class="field-label">Имя *</span><input class="input" id="dlName" maxlength="60" autocomplete="off"></label>
      <label class="field"><span class="field-label">Телефон *</span><input class="input" id="dlPhone" type="tel" inputmode="tel" placeholder="+7 (000) 000-00-00"></label>
      <label class="field"><span class="field-label">Адрес *</span><div style="display:flex;align-items:center;gap:8px"><span class="faint" style="white-space:nowrap">${esc(L.addrPrefix)}</span><input class="input" id="dlAddr" maxlength="80" placeholder="ул. Пушкина, д. 5, кв. 12"></div></label>
      <label class="field"><span class="field-label">Комментарий</span><input class="input" id="dlNote" maxlength="120" placeholder="Домофон 42"></label>
      <div class="segmented" style="justify-self:start" id="dlPay"><button type="button" data-pay="cash" aria-pressed="true">${icon('cash')} Наличные</button><button type="button" data-pay="card" aria-pressed="false">${icon('card')} Карта</button></div>
      <div class="field-error" id="dlErr" hidden></div>
    </form>
    <div class="modal-foot"><button class="btn btn--primary btn--lg btn--block" type="submit" form="dlForm">К выбору блюд ${icon('arrowRight')}</button></div>`);
  $$('#dlPay svg', d).forEach(s => s.setAttribute('style', 'width:15px;height:15px;vertical-align:-3px'));
  bindPhoneMask($('#dlPhone', d));
  $('#dlPay', d).onclick = e => { const b = e.target.closest('[data-pay]'); if (!b) return; pay = b.dataset.pay; $$('[data-pay]', d).forEach(x => x.setAttribute('aria-pressed', x === b)); };
  $('#dlForm', d).onsubmit = e => {
    e.preventDefault();
    const name = $('#dlName', d).value.trim(), phone = $('#dlPhone', d).value, addr = $('#dlAddr', d).value.trim();
    const err = $('#dlErr', d);
    const msg = !name ? 'Укажите имя' : phoneDigits(phone).length < 11 ? 'Укажите полный телефон' : addr.length < 3 ? 'Укажите адрес' : '';
    if (msg) { err.hidden = false; err.textContent = msg; return; }
    st.seqDel++;
    const id = `del_${Date.now().toString(36)}`;
    st.open[id] = makeOrder({ id, name: `Доставка — ${name}`, type: 'delivery', customer: name, phone, address: L.addrPrefix + addr, comment: $('#dlNote', d).value.trim(), payment: pay });
    save(); closeModal(d); openOrder(id);
  };
  d.addEventListener('closed', () => d.remove());
  openModal(d);
}

// ═══════════════════════════════════════════════════════════════
//  ЭКРАН ЗАКАЗА (POS)
// ═══════════════════════════════════════════════════════════════
function openOrder(id) {
  activeId = id;
  left = null; leftCounts = {};
  refreshLeft();
  const o = st.open[id];
  shell.setTitle(o.name, o.type === 'delivery' ? o.address : o.type === 'take' ? 'Самовывоз' : `${o.guests} ${guestWord(o.guests)}`);
  const c = $('#content');
  c.style.padding = '0';
  c.innerHTML = `<div class="pos">
    <nav class="pos-cats" id="posCats" aria-label="Категории"></nav>
    <div class="pos-grid-area">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn--ghost btn--sm" type="button" id="back">${icon('arrowLeft')} Все столы</button>
        <div class="search-in" style="max-width:none">${icon('search')}<input class="input" id="posQ" placeholder="Поиск блюда" style="height:36px;min-height:36px;padding-top:6px;padding-bottom:6px"></div>
      </div>
      <div class="pos-hot" id="posHot"></div>
      <div class="pos-items" id="posItems"></div>
    </div>
    <aside class="pos-order" id="posOrder"></aside>
  </div>`;
  $('#back').onclick = backToTables;
  $('#posQ').oninput = debounce(e => { query = norm(e.target.value.trim()); renderGrid(); }, 150);
  $('#posCats').onclick = e => { const b = e.target.closest('[data-cat]'); if (!b) return; catIdx = Number(b.dataset.cat); query = ''; $('#posQ').value = ''; renderCats(); renderGrid(); };
  $('#posItems').onclick = e => { const b = e.target.closest('[data-item]'); if (b) pickItem(b.dataset.item); };
  $('#posHot').onclick = e => { const b = e.target.closest('[data-item]'); if (b) pickItem(b.dataset.item); };
  $('#posOrder').addEventListener('click', onOrderClick);
  renderCats(); renderGrid(); renderOrder();
}

function backToTables() {
  const o = st.open[activeId];
  if (o && !o.rounds.length && !newTotal(o)) delete st.open[activeId];      // пустой заказ — не держим
  save();
  renderTables();
}

function renderCats() {
  $('#posCats').innerHTML = menu.categories.map((c, i) => {
    const items = menu.items.filter(it => it.cat === c.id);
    const stop = items.filter(it => it.available === false).length;
    return `<button class="pos-cat${i === catIdx ? ' on' : ''}" type="button" data-cat="${i}" style="border-left-color:${i === catIdx ? CAT_COLORS[c.id] : 'transparent'}">${esc(c.name)}<small>${items.length} поз.${stop ? ` · стоп ${stop}` : ''}</small></button>`;
  }).join('');
}

function renderGrid() {
  if (!$('#posItems')) return;
  const o = st.open[activeId];
  const counts = {};
  o.guestCarts.flat().forEach(l => { counts[l.id] = (counts[l.id] || 0) + l.qty; });
  const cat = menu.categories[catIdx];
  const items = query
    ? menu.items.filter(it => norm(it.name).includes(query))
    : menu.items.filter(it => it.cat === cat?.id);
  $('#posItems').innerHTML = items.length ? items.map(it => `
    <button class="pi${it.available === false ? ' stop' : ''}" type="button" data-item="${it.id}" style="--cc:${CAT_COLORS[it.cat] || 'var(--brand)'}" ${it.available === false ? `aria-label="${esc(it.name)} — в стоп-листе" title="${esc(it.stop_reason || 'Нет в наличии')}"` : ''}>
      ${counts[it.id] ? `<span class="pq">${counts[it.id]}</span>` : ''}
      <span class="pn">${esc(it.name)}</span><span class="pw">${esc(it.weight || '')}</span>
      ${it.available !== false && leftShown(it, counts[it.id]) !== null ? `<span class="pl${leftClass(leftShown(it, counts[it.id]))}" title="Сколько ещё пропустит склад с учётом этого заказа">${leftLabel(leftShown(it, counts[it.id]))}</span>` : ''}
      ${it.available !== false && it.hot ? `<span class="phl" title="${esc(it.hot.reason || 'Предложите гостю')}">${icon('flame')} горячее предложение</span>` : ''}
      <span class="pp">${it.price2 || it.variantOpts ? 'от ' : ''}${money(it.price)}</span>
    </button>`).join('') : `<div class="empty" style="grid-column:1/-1">${icon('search')}<div>Ничего не найдено</div></div>`;
  const hot = menu.items.filter(i => i.hot && i.available !== false).sort((a, b) => b.hot.priority - a.hot.priority).slice(0, 6);
  $('#posHot').innerHTML = hot.length ? `<span class="pos-hot-lbl">${icon('flame')} Предложите гостю:</span>${hot.map(h => `<button class="chip chip-sm" type="button" data-item="${h.id}">${esc(h.name)}</button>`).join('')}` : '';
}

/** Счётчик на карточке: как только позицию пробили, и всегда — на последних порциях. */
function leftShown(it, inCart) {
  const n = leftOf(it);
  if (n === null) return it.portions_left || null;
  return inCart || n <= 3 ? n : null;
}

function pickItem(id) {
  const it = menu.byId[id];
  if (!it) return;
  if (it.available === false) return showStop(it);
  // Склад видит, сколько порций можно собрать: больше этого заказ не пройдёт — предупреждаем сразу
  if (leftOf(it) === 0) return noMore(it);
  if (!it.price2 && !it.variantOpts) return addLine(it, 0, 0);
  const can = i => (!it.variants_available || it.variants_available[i]) && leftOf(it, i) !== 0;
  const sizes = it.price2 ? (it.pizza ? ['30 см', '40 см'] : it.sizes) : null;
  const opts = it.variantOpts || sizes;
  const first = Math.max(0, opts.findIndex((_, i) => can(i)));
  let size = it.variantOpts ? 0 : first, variant = it.variantOpts ? first : 0;
  const d = createModal(`
    <div class="modal-head"><div style="flex:1"><h2 class="modal-title">${esc(it.name)}</h2><p class="modal-sub">${esc(it.weight || '')}</p></div><button class="modal-close" type="button" data-close>${icon('x')}</button></div>
    <div class="modal-body" style="display:grid;gap:14px">
      ${it.variantOpts ? `<div class="segmented" style="flex-wrap:wrap">${it.variantOpts.map((v, i) => `<button type="button" data-v="${i}" aria-pressed="${i === variant}" ${!can(i) ? 'disabled title="Нет в наличии" style="opacity:.4;text-decoration:line-through"' : ''}>${esc(v)}${sizeLeft(it, i)}</button>`).join('')}</div>` : ''}
      ${sizes ? `<div class="segmented">${sizes.map((s, i) => `<button type="button" data-s="${i}" aria-pressed="${i === size}" ${!can(i) ? 'disabled title="Больше нет" style="opacity:.4;text-decoration:line-through"' : ''}>${esc(s)} · ${money(i ? it.price2 : it.price)}${sizeLeft(it, i)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="modal-foot"><button class="btn btn--primary btn--lg btn--block" type="button" id="pkGo">Добавить</button></div>`);
  d.style.maxWidth = '460px';
  d.addEventListener('click', e => {
    const v = e.target.closest('[data-v]:not([disabled])'), s = e.target.closest('[data-s]:not([disabled])');
    if (v) { variant = Number(v.dataset.v); $$('[data-v]', d).forEach(x => x.setAttribute('aria-pressed', x === v)); }
    if (s) { size = Number(s.dataset.s); $$('[data-s]', d).forEach(x => x.setAttribute('aria-pressed', x === s)); }
  });
  $('#pkGo', d).onclick = () => { addLine(it, size, variant); closeModal(d); };
  d.addEventListener('closed', () => d.remove());
  openModal(d);
}

/**
 * Блюдо в стоп-листе: пробить нельзя — по складу продуктов нет, заказ не пройдёт.
 * Показываем причину и что предложить гостю вместо (доступное из той же категории, «горячее» — первым).
 */
function showStop(it) {
  const alts = menu.items
    .filter(x => x.cat === it.cat && x.id !== it.id && x.available !== false)
    .filter(x => leftOf(x) !== 0)   // уже не добрать — не предлагаем
    .sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0))
    .slice(0, 4);
  const d = createModal(`
    <div class="modal-head"><div style="flex:1"><h2 class="modal-title">${esc(it.name)} — в стоп-листе</h2>
      <p class="modal-sub">${esc(it.stop_reason || 'Нет в наличии')}</p></div>
      <button class="modal-close" type="button" data-close>${icon('x')}</button></div>
    <div class="modal-body" style="display:grid;gap:16px">
      <p style="margin:0">Пробить не получится: по складу продуктов нет, и заказ не пройдёт. Если продукт на самом деле есть —
        его нужно оприходовать во Флагмане (приёмка или пересчёт), и блюдо само вернётся в продажу.</p>
      ${alts.length ? `<div><div class="field-label" style="margin-bottom:8px">Предложите гостю вместо</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${alts.map(a => `<button class="chip" type="button" data-alt="${a.id}">
          ${a.hot ? icon('flame') : ''}${esc(a.name)} · ${money(a.price)}</button>`).join('')}</div></div>` : ''}
    </div>
    <div class="modal-foot"><button class="btn btn--ghost btn--block" type="button" data-close>Понятно</button></div>`);
  d.style.maxWidth = '480px';
  d.addEventListener('click', e => {
    const b = e.target.closest('[data-alt]');
    if (!b) return;
    closeModal(d);
    pickItem(b.dataset.alt);
  });
  d.addEventListener('closed', () => d.remove());
  openModal(d);
}

function lineName(it, size, variant) {
  let n = it.variantOpts ? (it.variantNames?.[variant] || `${it.name} ${it.variantOpts[variant].toLowerCase()}`) : it.name;
  if (it.price2) n += it.pizza ? (size ? ', 40 см' : ', 30 см') : `, ${it.sizes[size].toLowerCase()}`;
  return n;
}

/** «· ещё 3» на кнопке размера, если по этому размеру осталось немного. */
function sizeLeft(it, i) {
  const n = leftOf(it, i);
  return n !== null && n > 0 && n <= 5 ? ` · ещё ${n}` : '';
}

function addLine(it, size, variant) {
  if (leftOf(it, it.variantOpts ? variant : size) === 0) return noMore(it);
  const o = st.open[activeId];
  const cart = cartOf(o);
  const key = `${it.id}|${size}|${variant}`;
  const ex = cart.find(l => l.key === key);
  if (ex) ex.qty++;
  else cart.push({ key, id: it.id, name: lineName(it, size, variant), price: size && it.price2 ? it.price2 : it.price, qty: 1, size, variant });
  save(); renderGrid(); renderOrder(); refreshLeftSoon();
}

function renderOrder() {
  const o = st.open[activeId];
  const el = $('#posOrder');
  const pay = o.guestPay[o.activeGuest] || 'cash';
  const cart = cartOf(o);
  const sent = o.rounds.flatMap(r => r.items.filter(l => (l.guest ?? 0) === o.activeGuest));
  const total = sentTotal(o) + newTotal(o);
  el.innerHTML = `
    <div class="po-h"><h3>${esc(o.name)}</h3><div class="faint" style="font-size:12.5px">${o.type === 'delivery' ? `${esc(o.customer)} · ${esc(o.phone)}` : o.type === 'take' ? (o.phone ? esc(o.phone) : 'Самовывоз') : `${o.zone === 'hall' ? 'Зал' : 'Веранда'} · ${o.guests} ${guestWord(o.guests)}`} · ${elapsed(o.startTime)}</div></div>
    ${o.guests > 1 ? `<div class="po-guests">${o.guestCarts.map((g, i) => `<button class="chip chip-sm${i === o.activeGuest ? ' on' : ''}" type="button" data-guest="${i}">Гость ${i + 1}${g.length ? ` · ${g.reduce((s, l) => s + l.qty, 0)}` : ''}</button>`).join('')}</div>` : ''}
    <div class="po-b">
      ${sent.length ? `<div class="po-sec">На кухне</div>${sent.map(l => `<div class="po-line sent"><span class="pn">${esc(l.name)}${l.qty > 1 ? ` ×${l.qty}` : ''}</span><span></span><span class="pp">${money(l.price * l.qty)}</span></div>`).join('')}` : ''}
      ${cart.length ? `<div class="po-sec">${sent.length ? 'Добавить' : 'Новый заказ'}</div>${cart.map((l, i) => { const it = menu.byId[l.id]; const n = it ? leftOf(it, sizeIdx(it, l)) : null; return `<div class="po-line"><span class="pn">${esc(l.name)}${n !== null ? `<small class="po-left${n <= 1 ? ' last' : ''}">${n === 0 ? 'больше нет' : `ещё можно ${n}`}</small>` : ''}</span>
        <span class="stepper-sm"><button type="button" data-q="${i}" data-d="-1" aria-label="Меньше">${icon(l.qty === 1 ? 'trash' : 'minus')}</button><output>${l.qty}</output><button type="button" data-q="${i}" data-d="1" aria-label="Больше" ${n === 0 ? 'disabled' : ''}>${icon('plus')}</button></span>
        <span class="pp">${money(l.price * l.qty)}</span></div>`; }).join('')}` : !sent.length ? `<div class="empty" style="padding:30px 10px">${icon('receipt')}<div>Выберите блюда слева</div></div>` : ''}
    </div>
    <div class="po-f">
      <input class="input" id="poNote" placeholder="Комментарий для кухни" maxlength="120" value="${esc(o.comment || '')}" style="min-height:38px;height:38px;font-size:14px">
      <div class="segmented" style="width:100%"><button type="button" data-pay="cash" aria-pressed="${pay === 'cash'}" style="flex:1">${icon('cash')} Наличные</button><button type="button" data-pay="card" aria-pressed="${pay === 'card'}" style="flex:1">${icon('card')} Карта</button></div>
      <div class="po-total"><span class="muted">Итого${o.rounds.length ? ` · отправлено ${money(sentTotal(o))}` : ''}</span><b>${money(total)}</b></div>
      <button class="btn btn--primary btn--lg btn--block" type="button" id="poSend" ${newTotal(o) ? '' : 'disabled'}>${icon('chef')} ${o.rounds.length ? 'Дозаказать' : 'Принять заказ'} · ${money(newTotal(o))}</button>
      <div style="display:flex;gap:8px">
        <button class="btn btn--ghost btn--sm" type="button" id="poClear" style="flex:1" ${cart.length ? '' : 'disabled'}>Очистить</button>
        <button class="btn btn--ghost btn--sm" type="button" id="poClose" style="flex:1" ${o.rounds.length || o.type === 'take' ? '' : 'disabled'}>${o.type === 'dine' ? 'Закрыть стол' : 'Завершить'}</button>
      </div>
    </div>`;
  $$('.segmented svg', el).forEach(s => s.setAttribute('style', 'width:15px;height:15px;vertical-align:-3px;margin-right:2px'));
  $('#poSend svg', el)?.setAttribute('style', 'width:18px;height:18px');
  $('#poNote', el).oninput = e => { o.comment = e.target.value; save(); };
}

async function onOrderClick(e) {
  const o = st.open[activeId];
  const g = e.target.closest('[data-guest]');
  if (g) { o.activeGuest = Number(g.dataset.guest); save(); renderOrder(); return; }
  const q = e.target.closest('[data-q]');
  if (q) {
    const cart = cartOf(o), l = cart[Number(q.dataset.q)];
    const it = menu.byId[l.id];
    if (Number(q.dataset.d) > 0 && it && leftOf(it, sizeIdx(it, l)) === 0) return noMore(it);
    l.qty += Number(q.dataset.d);
    if (l.qty <= 0) cart.splice(Number(q.dataset.q), 1);
    save(); renderOrder(); renderGrid(); refreshLeftSoon(); return;
  }
  const p = e.target.closest('[data-pay]');
  if (p) { o.guestPay[o.activeGuest] = p.dataset.pay; save(); renderOrder(); return; }
  if (e.target.closest('#poClear')) { o.guestCarts[o.activeGuest] = []; save(); renderOrder(); renderGrid(); refreshLeftSoon(); return; }
  if (e.target.closest('#poClose')) return closeOrder(o);
  if (e.target.closest('#poSend')) return submit(o, e.target.closest('#poSend'));
}

// ── Отправка раунда ────────────────────────────────────────────
async function submit(o, btn) {
  const lines = o.guestCarts.flatMap((g, gi) => g.map(l => ({ ...l, guest: gi })));
  if (!lines.length) return;
  const roundTotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const pay = o.guestPay[0] || 'cash';
  const items = lines.map(l => ({ id: l.id, name: o.guests > 1 ? `[Г${l.guest + 1}] ${l.name}` : l.name, price: l.price, qty: l.qty, size: l.size, variant: l.variant }));
  btn.classList.add('is-loading');
  try {
    let res;
    if (o.type === 'delivery') {
      res = await api.order(loc, { customer: o.customer, phone: o.phone, address: o.address, type: 'delivery', comment: o.comment || '', payment: pay, items, source: 'kassir' });
    } else {
      const zone = o.type === 'take' ? 'Самовывоз' : o.zone === 'hall' ? 'Зал' : 'Летняя веранда';
      const auto = `${zone} | ${o.guests} ${guestWord(o.guests)}`;
      res = await api.cashier(loc, { table: o.name, comment: o.comment ? `${auto}\n${o.comment}` : auto, payment: pay, items, type: o.type, zone: o.zone });
    }
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    o.rounds.push({ orderNumber: res.orderNumber, total: roundTotal, time, items: lines });
    o.serverOrderNum = res.orderNumber;
    o.serverStatus = o.type === 'delivery' ? CONFIG.STATUS.NEW : CONFIG.STATUS.COOKING;
    o.guestCarts = o.guestCarts.map(() => []);
    o.comment = '';
    left = null; leftCounts = {};
    if (o.type !== 'delivery') st.done.push({ orderNumber: res.orderNumber, tableName: o.name, items: lines.map(({ name, qty, price }) => ({ name, qty, price })), total: roundTotal, payment: pay, time, type: o.type, status: 'done' });
    save();
    const cash = o.guestPay.some(p => p === 'cash') ? lines.filter(l => (o.guestPay[l.guest] || 'cash') === 'cash').reduce((s, l) => s + l.price * l.qty, 0) : 0;
    const done = () => showSuccess(res.orderNumber, roundTotal, pay);
    if (cash > 0 && o.type !== 'delivery') cashCalc(cash, done); else done();
  } catch (ex) {
    btn.classList.remove('is-loading');
    if (ex.code === 'OUT_OF_STOCK') {
      const names = (ex.data.unavailable || []).map(u => u.name);
      toast('Не хватает ингредиентов', { type: 'err', text: names.join(', '), timeout: 5000 });
      loadMenu();
    } else toast('Заказ не отправлен', { type: 'err', text: ex.message });
  }
}

function cashCalc(target, after) {
  let got = 0;
  const d = createModal(`
    <div class="modal-head"><div style="flex:1"><h2 class="modal-title">Расчёт сдачи</h2><p class="modal-sub">К оплате наличными: <b>${money(target)}</b></p></div></div>
    <div class="modal-body" style="display:grid;gap:12px">
      <div class="bills">${[50, 100, 200, 500, 1000, 2000, 5000].map(b => `<button type="button" data-b="${b}">${num(b)}</button>`).join('')}<button type="button" data-b="exact" style="font-size:12px">Без сдачи</button></div>
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="muted">Получено: <b id="ccGot" style="color:var(--text)">0 ₽</b></span><button class="btn btn--ghost btn--sm" type="button" id="ccReset">Сброс</button></div>
      <div class="change" id="ccChange"><span>Сдача</span><b>—</b></div>
    </div>
    <div class="modal-foot"><button class="btn btn--primary btn--lg btn--block" type="button" data-close>Готово</button></div>`);
  d.style.maxWidth = '460px';
  const upd = () => {
    $('#ccGot', d).textContent = money(got);
    const ch = got - target, box = $('#ccChange', d);
    box.className = `change ${!got ? '' : ch >= 0 ? 'ok' : 'err'}`;
    box.querySelector('b').textContent = got ? money(ch) : '—';
  };
  d.addEventListener('click', e => { const b = e.target.closest('[data-b]'); if (!b) return; got = b.dataset.b === 'exact' ? target : got + Number(b.dataset.b); upd(); });
  $('#ccReset', d).onclick = () => { got = 0; upd(); };
  d.addEventListener('closed', () => { d.remove(); after(); });
  openModal(d);
}

function showSuccess(numb, total, pay) {
  const d = createModal(`
    <div class="modal-body" style="text-align:center;padding:30px 22px 10px">
      <div class="confirm-ico" style="background:var(--ok-soft);color:var(--ok)">${icon('check')}</div>
      <div class="modal-title" style="font-size:2.6rem;margin-top:14px">№ ${esc(numb)}</div>
      <p class="muted" style="margin-top:6px">${money(total)} · ${pay === 'card' ? 'карта' : 'наличные'} · отправлено на кухню</p>
    </div>
    <div class="modal-foot" style="border:0"><button class="btn btn--primary btn--lg btn--block" type="button" data-close>К столам</button></div>`);
  d.style.maxWidth = '400px';
  d.addEventListener('closed', () => { d.remove(); renderTables(); });
  openModal(d);
}

async function closeOrder(o) {
  const yes = await confirmDialog({
    title: o.type === 'dine' ? `Закрыть ${o.name}?` : `Завершить ${o.name}?`,
    text: `${o.rounds.length ? `Сумма: <b>${money(sentTotal(o))}</b>. ` : ''}${o.type === 'dine' ? 'Стол станет свободным.' : 'Клиент забрал заказ.'}`,
    ok: o.type === 'dine' ? 'Закрыть стол' : 'Завершить', iconName: 'check',
  });
  if (!yes) return;
  if (o.type === 'take' && o.serverOrderNum) { try { await api.confirm(loc, o.serverOrderNum); } catch {} }
  delete st.open[o.id];
  save();
  renderTables();
}

// ── Статусы отправленных заказов ───────────────────────────────
async function pollStatuses() {
  const sent = Object.values(st.open).filter(o => o.serverOrderNum && o.type !== 'dine');
  let changed = false;
  await Promise.all(sent.map(async o => {
    try {
      const r = await api.track(loc, o.serverOrderNum);
      if (r.status === o.serverStatus) return;
      o.serverStatus = r.status; changed = true;
      if (DONE_STATUSES.includes(r.status)) {
        const cancelled = r.status === CONFIG.STATUS.CANCELLED;
        if (o.type === 'delivery') st.done.push({ orderNumber: o.serverOrderNum, tableName: o.name, items: allLines(o).map(({ name, qty, price }) => ({ name, qty, price })), total: sentTotal(o), payment: o.guestPay[0], time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), type: 'delivery', status: cancelled ? 'cancelled' : 'done' });
        else { const d = st.done.find(x => x.orderNumber == o.serverOrderNum); if (d && cancelled) d.status = 'cancelled'; }
        toast(`${o.name}: ${r.status.toLowerCase()}`, { type: cancelled ? 'warn' : 'ok' });
        if (activeId !== o.id) delete st.open[o.id];
      }
    } catch {}
  }));
  if (changed) { save(); if (!activeId) renderTables(); }
}

// ── Старт ──────────────────────────────────────────────────────
await loadMenu();
renderTables();
pollStatuses();
shell.live(debounce(ev => {
  if (['stock.changed', 'stoplist.changed', 'tick'].includes(ev.type)) { loadMenu(); if (activeId) refreshLeft(); }
  if (ev.type.startsWith('order') || ev.type === 'tick') pollStatuses();
}, 300));
setInterval(() => { if (!activeId && !document.querySelector('dialog[open]')) renderTables(); }, 30000);
