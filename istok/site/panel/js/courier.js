// ═══════════════════════════════════════════════════════════════
//  Панель — КУРЬЕР (mobile-first)
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, money, fmtTime, elapsed, debounce, plural } from '../../shared/js/utils.js';
import { icon, toast, confirmDialog, countUp } from '../../shared/js/ui.js';
import { api } from '../../shared/js/api.js';
import { CONFIG } from '../../shared/js/config.js';
import { initShell, beep } from './shell.js';
import { parseItems } from './common.js';

const shell = await initShell({ page: 'courier', title: 'Курьер' });
const { loc } = shell;
const ST = CONFIG.STATUS;
const TABS = [
  { id: 'wait', title: 'Забрать', ic: 'box', match: o => [ST.NEW, ST.ACCEPTED, ST.COOKING, ST.READY].includes(o.status) },
  { id: 'going', title: 'В пути', ic: 'scooter', match: o => o.status === ST.ON_WAY },
  { id: 'done', title: 'Доставлено', ic: 'check', match: o => [ST.DONE, ST.CANCELLED].includes(o.status) },
];
let tab = 'wait', orders = [], known = null;

$('#content').innerHTML = `
  <div class="courier-wrap">
    <section class="kpis" id="kpis" style="grid-template-columns:repeat(3,1fr)"></section>
    <div class="card" style="position:sticky;top:70px;z-index:5"><div class="tabs" role="tablist" id="tabs"></div></div>
    <div id="list" style="display:flex;flex-direction:column;gap:14px"></div>
  </div>`;

function render() {
  const del = orders.filter(o => o.type === 'delivery');
  const counts = Object.fromEntries(TABS.map(t => [t.id, del.filter(t.match).length]));
  const K = [['wait', 'warn', 'box', 'Забрать'], ['going', 'brand', 'scooter', 'В пути'], ['done', 'ok', 'check', 'Доставлено']];
  if (!$('#kpis').children.length) $('#kpis').innerHTML = K.map(([k, c, ic, t]) => `<div class="kpi ${c}" data-k="${k}"><div class="kpi-top"><span class="kpi-ico">${icon(ic)}</span>${t}</div><div class="kpi-val"><span class="v">0</span></div></div>`).join('');
  K.forEach(([k]) => countUp($(`#kpis [data-k="${k}"] .v`), counts[k]));
  $('#tabs').innerHTML = TABS.map(t => `<button class="tab" type="button" role="tab" aria-selected="${tab === t.id}" data-tab="${t.id}">${esc(t.title)}<span class="n">${counts[t.id]}</span></button>`).join('');
  shell.setBadge('courier', del.filter(o => o.status === ST.READY).length);

  const list = del.filter(TABS.find(t => t.id === tab).match);
  $('#list').innerHTML = list.length ? list.map(card).join('') : `<div class="empty card">${icon(tab === 'going' ? 'scooter' : tab === 'done' ? 'check' : 'box')}<div class="empty-title">${tab === 'wait' ? 'Нет заказов для доставки' : tab === 'going' ? 'Нет заказов в пути' : 'Пока ничего не доставлено'}</div><div>Новые заказы появятся автоматически</div></div>`;
}

function card(o) {
  const items = parseItems(o.items);
  const ready = o.status === ST.READY;
  const map = `https://2gis.ru/search/${encodeURIComponent(o.address || '')}`;
  let actions = '';
  if (ready) actions = `<button class="btn btn--primary btn--lg" type="button" data-act="pick" style="grid-column:1/-1">${icon('bag')} Забрал из кафе</button>`;
  else if (o.status === ST.ON_WAY) actions = `<button class="btn btn--ok btn--lg" type="button" data-act="done" style="grid-column:1/-1">${icon('check')} Доставил</button>`;
  else if ([ST.NEW, ST.ACCEPTED, ST.COOKING].includes(o.status)) actions = `<div class="faint" style="grid-column:1/-1;text-align:center;font-size:13px;padding:6px">${icon('chef')} Готовится на кухне…</div>`;
  return `<article class="cc" data-id="${o.id}">
    <div class="cc-addr">
      <div style="display:flex;align-items:center;gap:8px"><span class="lbl">№ ${esc(o.order_number)} · ${fmtTime(o.created_at)}</span>
        <span style="margin-left:auto" class="st ${o.status === ST.ON_WAY ? 'st-way' : o.status === ST.READY ? 'st-ready' : o.status === ST.DONE ? 'st-done' : o.status === ST.CANCELLED ? 'st-cancel' : 'st-cook'}">${esc(o.status)}</span></div>
      <div class="val">${esc(o.address || 'Адрес не указан')}</div>
    </div>
    <div class="oc-meta" style="padding:12px 16px 0;font-size:14px">
      <div>${icon('user')}<span>${esc(o.customer || '—')}</span></div>
      ${o.comment ? `<div>${icon('message')}<span>${esc(o.comment)}</span></div>` : ''}
      <div>${icon('receipt')}<span>${items.map(i => `${esc(i.name)} × ${i.qty}`).join(', ')}</span></div>
    </div>
    <div style="display:flex;align-items:baseline;gap:8px;padding:12px 16px 0"><b style="font-size:1.3rem;font-variant-numeric:tabular-nums">${money(o.grand_total)}</b>
      <span class="faint" style="font-size:12px">${o.payment === 'card' ? 'картой' : 'наличными'}${o.delivery_cost ? ` · вкл. доставку ${money(o.delivery_cost)}` : ''}</span></div>
    <div class="cc-actions">
      ${o.phone ? `<a class="btn btn--ghost btn--lg" href="tel:${esc(o.phone)}">${icon('phone')} Позвонить</a>` : '<span></span>'}
      <a class="btn btn--ghost btn--lg" href="${map}" target="_blank" rel="noopener">${icon('map')} Маршрут</a>
      ${actions}
    </div>
  </article>`;
}

$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; render(); } });
$('#list').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const o = orders.find(x => x.id == e.target.closest('.cc').dataset.id);
  const pick = act === 'pick';
  const yes = await confirmDialog(pick
    ? { title: `Забрать № ${o.order_number}?`, text: 'Клиент увидит, что заказ в пути.', ok: 'Да, забрал', iconName: 'bag' }
    : { title: `№ ${o.order_number} доставлен?`, text: 'Подтвердите, что передали заказ клиенту.', ok: 'Да, доставил', iconName: 'check' });
  if (!yes) return;
  try {
    await api.setStatus(loc, o.id, pick ? ST.ON_WAY : ST.DONE);
    toast(pick ? 'Хорошей дороги!' : 'Отлично, заказ закрыт', { type: 'ok' });
    if (pick) tab = 'going';
    load();
  } catch (ex) { toast('Не удалось обновить статус', { type: 'err', text: ex.message }); }
});

async function load() {
  try {
    orders = await api.orders(loc);
    const readyNow = orders.filter(o => o.type === 'delivery' && o.status === ST.READY);
    if (known && readyNow.some(o => !known.has(o.id))) { beep(); toast('Есть заказ для доставки', { type: 'info', icon: 'bell' }); }
    known = new Set(readyNow.map(o => o.id));
    render();
    shell.setLiveError(false);
  } catch (e) {
    shell.setLiveError(true);
    if (e.status === 401) location.href = `login.html?back=courier.html?loc=${loc}`;
  }
}
await load();
shell.live(debounce(() => load(), 200));
