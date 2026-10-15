// ═══════════════════════════════════════════════════════════════
//  Панель — ЗАКАЗЫ (кухня / официант): общий список, как в старой панели BB
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, money, fmtTime, elapsed, store, debounce, plural } from '../../shared/js/utils.js';
import { icon, toast, confirmDialog, countUp } from '../../shared/js/ui.js';
import { api } from '../../shared/js/api.js';
import { CONFIG, DONE_STATUSES } from '../../shared/js/config.js';
import { initShell, beep, openSheet, canManage } from './shell.js';
import { statusBadge, typeLabel, parseItems } from './common.js';

const shell = await initShell({ page: 'ofick', title: 'Заказы' });
const { loc } = shell;
const ST = CONFIG.STATUS;

const CFG = {
  get flash() { return store.get('istok_of_flash', true); },
  get sound() { return store.get('istok_of_sound', true); },
};
// Фильтры: по статусу — только среди активных, по типу — везде
const FILTERS = [
  { k: 'all',      t: 'Все',            match: () => true },
  { k: 'cook',     t: 'Готовятся',      active: true, match: o => [ST.NEW, ST.ACCEPTED, ST.COOKING].includes(o.status) },
  { k: 'ready',    t: 'Готов к выдаче', active: true, match: o => o.status === ST.READY },
  { k: 'way',      t: 'В пути',         active: true, match: o => o.status === ST.ON_WAY },
  { k: 'delivery', t: 'Доставка',       match: o => o.type === 'delivery' },
  { k: 'pickup',   t: 'Самовывоз',      match: o => o.type === 'pickup' },
  { k: 'hall',     t: 'Зал',            match: o => ['hall', 'terrace'].includes(o.type) },
];

let orders = [], stats = null, known = null, view = 'active', filter = 'all';
const busy = new Set();

// ── Отметки выдачи кухни (локально, как в старой панели) ──────
const KI = {
  key: id => `istok_ki_${loc}_${id}`,
  get: id => store.get(KI.key(id), {}),
  toggle(id, idx) { const d = KI.get(id); d[idx] = !d[idx]; store.set(KI.key(id), d); return d; },
};

// ── Разметка ───────────────────────────────────────────────────
$('#content').innerHTML = `
  <div class="page-head">
    <div><h1>Заказы</h1><p>Кухня и выдача. Отмечайте блюда — заказ сам перейдёт в «Готов».</p></div>
    <div class="actions"><button class="btn btn--ghost" type="button" id="btnSettings">${icon('settings')} Настройки</button></div>
  </div>
  <section class="kpis" id="kpis"></section>
  <div class="card">
    <div class="toolbar">
      <div class="segmented" role="tablist">
        <button type="button" data-view="active" aria-pressed="true">${icon('flame')} Активные <span id="cntActive"></span></button>
        <button type="button" data-view="done" aria-pressed="false">${icon('check')} Завершённые <span id="cntDone"></span></button>
      </div>
      <span style="flex:1"></span>
      <div style="display:flex;gap:6px;flex-wrap:wrap" id="filters">
        ${FILTERS.map(f => `<button class="chip chip-sm${f.k === 'all' ? ' on' : ''}" type="button" data-f="${f.k}"${f.active ? ' data-active-only' : ''}>${f.t}</button>`).join('')}
      </div>
      <span class="faint orders-count" id="orderCount"></span>
    </div>
    <div class="card-b" id="boardWrap"></div>
  </div>`;
$$('.segmented button svg').forEach(s => s.setAttribute('style', 'width:15px;height:15px;margin-right:2px;vertical-align:-3px'));

$$('[data-view]').forEach(b => b.onclick = () => {
  view = b.dataset.view;
  $$('[data-view]').forEach(x => x.setAttribute('aria-pressed', x === b));
  $$('#filters [data-active-only]').forEach(x => x.hidden = view === 'done');
  if (view === 'done' && FILTERS.find(f => f.k === filter).active) setFilter('all');
  render();
});
function setFilter(k) {
  filter = k;
  $$('#filters .chip').forEach(x => x.classList.toggle('on', x.dataset.f === k));
}
$('#filters').onclick = e => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  setFilter(b.dataset.f);
  render();
};
$('#btnSettings').onclick = openSettings;

// ── KPI ────────────────────────────────────────────────────────
function renderKpis() {
  const K = [
    { k: 'total', cls: 'brand', ic: 'receipt', t: 'Заказов сегодня', v: stats?.total ?? 0 },
    { k: 'cook', cls: 'warn', ic: 'chef', t: 'В работе', v: stats?.cooking ?? 0 },
    { k: 'way', cls: 'info', ic: 'scooter', t: 'В пути', v: stats?.on_way ?? 0 },
    { k: 'done', cls: 'ok', ic: 'check', t: 'Выполнено', v: stats?.done ?? 0 },
    { k: 'rev', cls: 'brand', ic: 'cash', t: 'Выручка сегодня', v: stats?.revenue_today ?? 0, s: '₽' },
  ];
  const root = $('#kpis');
  if (!root.children.length) root.innerHTML = K.map(x => `<div class="kpi ${x.cls}" data-k="${x.k}"><div class="kpi-top"><span class="kpi-ico">${icon(x.ic)}</span>${x.t}</div><div class="kpi-val"><span class="v">0</span>${x.s ? `<small>${x.s}</small>` : ''}</div></div>`).join('');
  K.forEach(x => countUp(root.querySelector(`[data-k="${x.k}"] .v`), Number(x.v) || 0));
}

// ── Карточка заказа ────────────────────────────────────────────
function card(o, isNew) {
  const items = parseItems(o.items);
  const ki = KI.get(o.id);
  const total = items.reduce((s, i) => s + (i.qty || 1), 0);
  const issued = Object.values(ki).filter(Boolean).length;
  let idx = 0;
  const rows = items.flatMap(it => Array.from({ length: it.qty || 1 }, (_, q) => {
    const i = idx++;
    const label = (it.qty || 1) > 1 ? `${esc(it.name)} <span class="faint">(${q + 1}/${it.qty})</span>` : esc(it.name);
    return `<div class="ki${ki[i] ? ' done' : ''}" data-ki="${i}" role="checkbox" aria-checked="${!!ki[i]}" tabindex="0"><span class="ki-box">${icon('check')}</span><span class="ki-name">${label}</span><span class="ki-price">${money(it.price)}</span></div>`;
  })).join('');
  const done = DONE_STATUSES.includes(o.status);
  const acts = [];
  if ([ST.NEW, ST.ACCEPTED].includes(o.status)) {
    acts.push(`<button class="btn btn--ghost btn--sm btn--icon" type="button" data-act="cancel" title="Отменить заказ" aria-label="Отменить">${icon('x')}</button>`);
    acts.push(`<button class="btn btn--primary btn--sm" type="button" data-act="${ST.COOKING}">${icon('chef')} В работу</button>`);
  } else if (o.status === ST.COOKING) {
    acts.push(`<button class="btn btn--soft btn--sm" type="button" data-act="${ST.READY}">${icon('check')} Готов</button>`);
  } else if (o.status === ST.READY) {
    if (o.type === 'delivery') acts.push(`<span class="faint" style="font-size:12px">ждёт курьера</span>`);
    else acts.push(`<button class="btn btn--ok btn--sm" type="button" data-act="${ST.DONE}">${icon('bag')} Выдан</button>`);
  } else if (o.status === ST.ON_WAY) {
    acts.push(`<span class="faint" style="font-size:12px">курьер в пути · ${elapsed(o.updated_at || o.created_at)}</span>`);
  } else if (done) {
    acts.push(`<button class="btn btn--ghost btn--sm" type="button" data-act="${ST.COOKING}">${icon('undo')} Вернуть в активные</button>`);
  }
  return `<article class="oc${done ? ' is-done' : ''}${isNew && CFG.flash ? ' new-flash' : ''}" data-id="${o.id}">
    <div class="oc-h"><span class="oc-num">№ ${esc(o.order_number)}</span><span class="oc-time" title="${esc(o.created_at)}">${fmtTime(o.created_at)} · ${elapsed(o.created_at)}</span>
      <span class="badges"><span class="badge">${esc(typeLabel(o.type))}</span>${statusBadge(o.status)}</span></div>
    ${o.confirmed_by_client ? `<div class="oc-banner">${icon('check')} Клиент подтвердил получение</div>` : ''}
    <div class="oc-meta">
      ${o.customer ? `<div>${icon('user')}<span>${esc(o.customer)}</span></div>` : ''}
      ${o.phone && o.phone !== '+7 (000) 000-00-00' ? `<div>${icon('phone')}<a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></div>` : ''}
      ${o.type === 'delivery' && o.address ? `<div>${icon('pin')}<span>${esc(o.address)}</span></div>` : ''}
    </div>
    ${o.comment ? `<div class="oc-comment">${icon('message')} ${esc(o.comment)}</div>` : ''}
    ${!done ? `<div class="oc-items">${rows}</div><div class="oc-progress${issued >= total ? ' full' : ''}"><i style="width:${total ? issued / total * 100 : 0}%"></i></div>` : ''}
    <div class="oc-f"><div class="oc-total">${money(o.grand_total)}${o.delivery_cost ? `<small>в т. ч. доставка ${money(o.delivery_cost)}</small>` : `<small>${items.length} ${plural(items.length, ['позиция', 'позиции', 'позиций'])}</small>`}</div><div class="acts">${acts.join('')}</div></div>
  </article>`;
}

function render() {
  const pass = FILTERS.find(f => f.k === filter).match;
  const active = orders.filter(o => !DONE_STATUSES.includes(o.status));
  const done = orders.filter(o => DONE_STATUSES.includes(o.status));
  $('#cntActive').textContent = active.length ? `· ${active.length}` : '';
  $('#cntDone').textContent = done.length ? `· ${done.length}` : '';
  shell.setBadge('ofick', active.filter(o => [ST.NEW, ST.ACCEPTED].includes(o.status)).length);
  const fresh = known ? new Set(orders.filter(o => !known.has(o.id)).map(o => o.id)) : new Set();
  const list = (view === 'done' ? done : active).filter(pass);
  $('#orderCount').textContent = `${list.length} ${plural(list.length, ['заказ', 'заказа', 'заказов'])}`;
  const all = view === 'done' ? done : active;
  $('#boardWrap').innerHTML = list.length
    ? `<div class="orders-grid">${list.map(o => card(o, fresh.has(o.id))).join('')}</div>`
    : `<div class="empty">${icon(view === 'done' ? 'check' : 'chef')}<div class="empty-title">${
        all.length ? 'Нет заказов по фильтру' : view === 'done' ? 'Завершённых заказов пока нет' : 'Активных заказов нет'}</div></div>`;
}

// ── Действия ───────────────────────────────────────────────────
async function setStatus(id, status) {
  if (busy.has(id)) return;
  busy.add(id);
  const o = orders.find(x => x.id === id);
  const prev = o?.status;
  if (o) { o.status = status; render(); }           // оптимистично
  try {
    await api.setStatus(loc, id, status);
    if (status === ST.DONE || status === ST.CANCELLED) store.remove(KI.key(id));
    toast(`№ ${o?.order_number}: ${status.toLowerCase()}`, { type: status === ST.CANCELLED ? 'warn' : 'ok' });
  } catch (e) {
    if (o) { o.status = prev; render(); }
    toast('Не удалось сменить статус', { type: 'err', text: e.message });
  } finally { busy.delete(id); load(); }
}

$('#boardWrap').addEventListener('click', async e => {
  const cardEl = e.target.closest('.oc');
  if (!cardEl) return;
  const id = Number(cardEl.dataset.id) || cardEl.dataset.id;
  const o = orders.find(x => x.id == id);
  const ki = e.target.closest('[data-ki]');
  if (ki && o) return toggleKi(o, Number(ki.dataset.ki));
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'cancel') {
    if (await confirmDialog({ title: `Отменить № ${o.order_number}?`, text: 'Если готовить ещё не начали — продукты вернутся на склад, если начали — уйдут в потери. Клиент увидит статус «Отменён».', ok: 'Отменить заказ', cancel: 'Назад', danger: true })) setStatus(o.id, ST.CANCELLED);
    return;
  }
  setStatus(o.id, act);
});
$('#boardWrap').addEventListener('keydown', e => {
  if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[data-ki]')) { e.preventDefault(); e.target.click(); }
});

function toggleKi(o, idx) {
  const d = KI.toggle(o.id, idx);
  const items = parseItems(o.items);
  const total = items.reduce((s, i) => s + (i.qty || 1), 0);
  const n = Object.values(d).filter(Boolean).length;
  const el = $(`.oc[data-id="${o.id}"]`);
  const row = el?.querySelector(`[data-ki="${idx}"]`);
  row?.classList.toggle('done', !!d[idx]);
  row?.setAttribute('aria-checked', String(!!d[idx]));
  const bar = el?.querySelector('.oc-progress');
  if (bar) { bar.querySelector('i').style.width = `${n / total * 100}%`; bar.classList.toggle('full', n >= total); }
  if (total > 0 && n >= total && [ST.NEW, ST.ACCEPTED, ST.COOKING].includes(o.status)) setTimeout(() => {
    // перепроверяем: вдруг повар снял галочку за эти полсекунды
    if (Object.values(KI.get(o.id)).filter(Boolean).length >= total) setStatus(o.id, ST.READY);
  }, 500);
}

// ── Загрузка ───────────────────────────────────────────────────
async function load() {
  try {
    const [list, st] = await Promise.all([api.orders(loc), api.stats(loc).catch(() => null)]);
    const fresh = known ? list.filter(o => !known.has(o.id) && !DONE_STATUSES.includes(o.status)) : [];
    orders = list;
    stats = st;
    renderKpis();
    render();
    known = new Set(list.map(o => o.id));
    if (fresh.length) {
      if (CFG.sound) beep();
      toast(fresh.length > 1 ? `Новых заказов: ${fresh.length}` : `Новый заказ № ${fresh[0].order_number}`, { type: 'info', icon: 'bell', text: fresh.map(f => typeLabel(f.type)).join(', ') });
    }
    shell.setLiveError(false);
  } catch (e) {
    shell.setLiveError(true);
    if (e.status === 401) location.href = `login.html?back=ofick.html?loc=${loc}`;
  }
}
const reload = debounce(load, 200);

// ── Настройки и инструменты ────────────────────────────────────
function openSettings() {
  const sw = (id, on, title, sub) => `<div style="display:flex;align-items:center;gap:12px"><div style="flex:1"><div class="strong">${title}</div><div class="faint" style="font-size:12.5px">${sub}</div></div><button class="switch" type="button" role="switch" aria-checked="${on}" id="${id}"></button></div>`;
  const sh = openSheet(`
    <div class="sheet-h"><div style="flex:1"><h2>Настройки</h2><p>Уведомления и служебные инструменты</p></div><button class="modal-close" type="button" data-close aria-label="Закрыть">${icon('x')}</button></div>
    <div class="sheet-b">
      ${sw('swFlash', CFG.flash, 'Подсветка новых заказов', 'Карточка мигает при появлении')}
      ${sw('swSound', CFG.sound, 'Звук нового заказа', 'Короткий сигнал')}
      <hr style="border:0;border-top:1px solid var(--line)">
      <div class="faint" style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Инструменты</div>
      <button class="btn btn--ghost" type="button" data-tool="export">${icon('download')} Сохранить заказы за сегодня</button>
      <button class="btn btn--ghost" type="button" data-tool="fix">${icon('refresh')} Сбросить «зависшие» статусы</button>
      ${canManage(shell.user) ? `<button class="btn btn--danger" type="button" data-tool="clearDone">${icon('trash')} Очистить завершённые</button>
      <button class="btn btn--danger" type="button" data-tool="clearActive">${icon('trash')} Очистить активные</button>` : ''}
    </div>`);
  const el = sh.el;
  $('#swFlash', el).onclick = e => { const v = !CFG.flash; store.set('istok_of_flash', v); e.currentTarget.setAttribute('aria-checked', v); };
  $('#swSound', el).onclick = e => { const v = !CFG.sound; store.set('istok_of_sound', v); e.currentTarget.setAttribute('aria-checked', v); if (v) beep(); };
  el.addEventListener('click', async e => {
    const t = e.target.closest('[data-tool]')?.dataset.tool;
    if (!t) return;
    try {
      if (t === 'export') { const r = await api.exportToday(loc); toast(`Сохранено: ${r.label}`, { type: 'ok', text: r.total != null ? `${r.total} заказов` : '' }); }
      if (t === 'fix') { const r = await api.fixStatuses(loc); toast(`Исправлено статусов: ${r.fixed}`, { type: 'ok' }); }
      if (t === 'clearDone' && await confirmDialog({ title: 'Удалить завершённые заказы?', text: 'Выполненные и отменённые заказы будут удалены с сервера.', ok: 'Удалить', danger: true })) { const r = await api.clearDone(loc); toast(`Удалено: ${r.deleted}`, { type: 'ok' }); }
      if (t === 'clearActive' && await confirmDialog({ title: 'Удалить активные заказы?', text: 'Все незавершённые заказы будут удалены. Действие необратимо.', ok: 'Удалить', danger: true })) { const r = await api.clearActive(loc); toast(`Удалено: ${r.deleted}`, { type: 'ok' }); }
      load();
    } catch (ex) { toast('Ошибка', { type: 'err', text: ex.message }); }
  });
}

// ── Старт ──────────────────────────────────────────────────────
await load();
shell.live(ev => { if (ev.type.startsWith('order') || ev.type === 'tick') reload(); });
setInterval(() => { if (!document.hidden) render(); }, 30000);   // обновить «… мин назад»
