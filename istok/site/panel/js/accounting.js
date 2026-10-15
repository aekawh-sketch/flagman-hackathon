// ═══════════════════════════════════════════════════════════════
//  Панель — БУХГАЛТЕРИЯ
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, num, money, isoDay, plural, debounce } from '../../shared/js/utils.js';
import { icon, toast, countUp } from '../../shared/js/ui.js';
import { api, saveBlob } from '../../shared/js/api.js';
import { initShell } from './shell.js';
import { renderChart, chartBase, cssVar, shortDay, rub } from './common.js';

const shell = await initShell({ page: 'accounting', title: 'Бухгалтерия' });
const { loc, L } = shell;
let data = null;

const today = new Date();
const PRESETS = [
  ['Сегодня', () => [today, today]],
  ['7 дней', () => [new Date(Date.now() - 6 * 864e5), today]],
  ['30 дней', () => [new Date(Date.now() - 29 * 864e5), today]],
  ['Этот месяц', () => [new Date(today.getFullYear(), today.getMonth(), 1), today]],
];

$('#content').innerHTML = `
  <div class="page-head">
    <div><h1>Бухгалтерия</h1><p>${esc(L.name)} · выручка, заказы и продажи по блюдам</p></div>
    <div class="actions">
      <div class="segmented" id="presets">${PRESETS.map(([t], i) => `<button type="button" data-p="${i}" aria-pressed="${i === 1}">${t}</button>`).join('')}</div>
    </div>
  </div>
  <div class="card"><div class="toolbar">
    <label class="field" style="flex-direction:row;align-items:center;gap:8px"><span class="field-label">С</span><input class="input" type="date" id="from" style="width:auto"></label>
    <label class="field" style="flex-direction:row;align-items:center;gap:8px"><span class="field-label">По</span><input class="input" type="date" id="to" style="width:auto"></label>
    <button class="btn btn--primary btn--sm" type="button" id="go">${icon('refresh')} Сформировать</button>
    <span style="flex:1"></span>
    <button class="btn btn--ghost btn--sm" type="button" id="xls">${icon('download')} Скачать Excel</button>
  </div></div>
  <section class="kpis" id="kpis"></section>
  <div class="card"><div class="card-h"><h2>${icon('chart')} Выручка по дням</h2><span class="sub" id="chSub"></span></div><div class="card-b"><div class="chart" id="chRev" style="height:300px"></div></div></div>
  <div class="grid-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
    <div class="card"><div class="card-h"><h2>${icon('calendar')} По дням</h2><span class="sub" id="dSub"></span></div><div class="tbl-wrap" id="daily"></div></div>
    <div class="card"><div class="card-h"><h2>${icon('receipt')} По блюдам</h2><span class="sub" id="iSub"></span></div><div class="tbl-wrap" id="items"></div></div>
  </div>`;

const setRange = ([a, b]) => { $('#from').value = isoDay(a); $('#to').value = isoDay(b); };
setRange(PRESETS[1][1]());
$('#presets').onclick = e => {
  const b = e.target.closest('[data-p]');
  if (!b) return;
  $$('#presets button').forEach(x => x.setAttribute('aria-pressed', x === b));
  setRange(PRESETS[b.dataset.p][1]());
  load();
};
$('#go').onclick = () => { $$('#presets button').forEach(x => x.setAttribute('aria-pressed', 'false')); load(); };
$('#xls').onclick = async () => {
  const btn = $('#xls');
  btn.classList.add('is-loading');
  try {
    const f = await api.accExcel(loc, $('#from').value, $('#to').value);
    saveBlob(f, `${L.label.replace(' · ', ' ')} ${$('#from').value} — ${$('#to').value}.xlsx`);
  } catch (e) { toast('Не удалось сформировать файл', { type: 'err', text: e.message }); }
  btn.classList.remove('is-loading');
};

async function load() {
  const from = $('#from').value, to = $('#to').value;
  if (!from || !to || from > to) { toast('Проверьте период', { type: 'warn', text: 'Дата начала не может быть позже конца' }); return; }
  $('#go').classList.add('is-loading');
  try {
    const [s, d, i] = await Promise.all([api.accSummary(loc, from, to), api.accDaily(loc, from, to), api.accItems(loc, from, to)]);
    data = { s, d, i };
    render();
  } catch (e) {
    if (e.status === 401) location.href = `login.html?back=accounting.html?loc=${loc}`;
    toast('Не удалось загрузить отчёт', { type: 'err', text: e.message });
  }
  $('#go').classList.remove('is-loading');
}

function render() {
  const { s, d, i } = data;
  const K = [
    ['brand', 'cash', 'Выручка', s.revenue, '₽'], ['info', 'receipt', 'Заказов', s.total_orders], ['ok', 'check', 'Выполнено', s.completed],
    ['danger', 'ban', 'Отменено', s.cancelled], ['warn', 'scooter', 'Доставок', s.deliveries, '', `доставка: ${money(s.delivery_fees)}`],
    ['', 'bag', 'Самовывоз и зал', s.pickups], ['brand', 'star', 'Средний чек', Math.round(s.avg_order), '₽'],
  ];
  if (!$('#kpis').children.length) $('#kpis').innerHTML = K.map(([c, ic, t, , suf], n) => `<div class="kpi ${c}" data-n="${n}"><div class="kpi-top"><span class="kpi-ico">${icon(ic)}</span>${t}</div><div class="kpi-val"><span class="v">0</span>${suf ? `<small>${suf}</small>` : ''}</div><div class="kpi-sub"></div></div>`).join('');
  K.forEach(([, , , v, , sub], n) => { const el = $(`#kpis [data-n="${n}"]`); countUp(el.querySelector('.v'), Number(v) || 0); el.querySelector('.kpi-sub').textContent = sub || ''; });

  // График (дни по возрастанию)
  const asc = [...d].sort((a, b) => a.date.localeCompare(b.date));
  $('#chSub').textContent = `${asc.length} ${plural(asc.length, ['день', 'дня', 'дней'])}`;
  drawChart(asc);

  // Таблица по дням
  const tot = d.reduce((a, r) => ({ total: a.total + +r.total, completed: a.completed + +r.completed, deliveries: a.deliveries + +r.deliveries, pickups: a.pickups + +r.pickups, revenue: a.revenue + +r.revenue, fees: a.fees + +r.delivery_fees }), { total: 0, completed: 0, deliveries: 0, pickups: 0, revenue: 0, fees: 0 });
  $('#dSub').textContent = d.length ? `${d.length} ${plural(d.length, ['день', 'дня', 'дней'])}` : '';
  $('#daily').innerHTML = d.length ? `<table class="tbl"><thead><tr><th>Дата</th><th class="num">Заказов</th><th class="num">Выполн.</th><th class="num">Доставок</th><th class="num">Выручка</th></tr></thead>
    <tbody>${d.map(r => `<tr><td class="strong">${esc(new Date(r.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' }))}</td><td class="num">${num(r.total)}</td><td class="num">${num(r.completed)}</td><td class="num">${num(r.deliveries)}</td><td class="num strong">${money(r.revenue)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Итого</td><td class="num">${num(tot.total)}</td><td class="num">${num(tot.completed)}</td><td class="num">${num(tot.deliveries)}</td><td class="num">${money(tot.revenue)}</td></tr></tfoot></table>`
    : `<div class="empty">${icon('calendar')}<div class="empty-title">Нет данных за период</div></div>`;

  // Таблица по блюдам
  const max = Math.max(1, ...i.map(r => +r.revenue));
  const sum = i.reduce((a, r) => a + +r.revenue, 0);
  $('#iSub').textContent = i.length ? `${i.length} ${plural(i.length, ['позиция', 'позиции', 'позиций'])}` : '';
  $('#items').innerHTML = i.length ? `<table class="tbl"><thead><tr><th>Блюдо</th><th class="num">Продано</th><th class="num">Выручка</th><th class="num">Доля</th></tr></thead>
    <tbody>${i.map(r => `<tr><td><div class="strong">${esc(r.name)}</div><div class="qtybar" style="max-width:220px"><i style="width:${+r.revenue / max * 100}%"></i></div></td><td class="num">${num(r.quantity)} шт</td><td class="num strong">${money(r.revenue)}</td><td class="num muted">${sum ? Math.round(+r.revenue / sum * 100) : 0}%</td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">${icon('receipt')}<div class="empty-title">Продаж нет</div></div>`;
}

function drawChart(asc) {
  const B = chartBase();
  const brand = cssVar('--brand');
  renderChart($('#chRev'), {
    ...B,
    tooltip: { ...B.tooltip, valueFormatter: v => rub(v) },
    xAxis: { ...B.xAxis, type: 'category', data: asc.map(r => shortDay(r.date)) },
    yAxis: { ...B.yAxis, type: 'value' },
    series: [
      { name: 'Выручка', type: 'bar', data: asc.map(r => +r.revenue), barMaxWidth: 34, itemStyle: { borderRadius: [6, 6, 0, 0], color: window.echarts ? new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: brand }, { offset: 1, color: 'rgba(226,96,63,.25)' }]) : brand } },
    ],
  });
}
addEventListener('themechange', () => data && setTimeout(() => drawChart([...data.d].sort((a, b) => a.date.localeCompare(b.date))), 50));

await load();
shell.setLiveError(false);
shell.live(debounce(ev => { if (ev.type.startsWith('order')) load(); }, 800));
