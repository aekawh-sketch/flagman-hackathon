// ═══════════════════════════════════════════════════════════════
//  Сайт — отслеживание моих заказов
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, money, fmtTime } from '../../../shared/js/utils.js';
import { icon, toast, createModal, openModal, closeModal, confirmDialog } from '../../../shared/js/ui.js';
import { api } from '../../../shared/js/api.js';
import { CONFIG } from '../../../shared/js/config.js';
import * as S from './state.js';
import * as M from './motion.js';

const ST = CONFIG.STATUS;
let dlg = null, timer = null, activeNum = null;

function stepOf(status, type) {
  if ([ST.DONE, ST.CANCELLED].includes(status)) return 4;
  if ((type === 'delivery' && status === ST.ON_WAY) || (type !== 'delivery' && status === ST.READY)) return 3;
  if (status === ST.COOKING || status === ST.READY) return 2;
  return 1;
}

function stepsHtml(o) {
  const loc = CONFIG.LOCATIONS[o.loc] || CONFIG.LOCATIONS[S.getLoc()] || Object.values(CONFIG.LOCATIONS)[0];
  const cancelled = o.status === ST.CANCELLED;
  const cur = stepOf(o.status, o.type);
  const steps = [
    { ic: 'receipt', t: 'Заказ принят', s: 'Мы получили заказ и проверили наличие' },
    { ic: 'chef', t: 'Готовится', s: 'Повар уже на кухне' },
    o.type === 'delivery'
      ? { ic: 'scooter', t: 'В пути', s: 'Курьер едет к вам' }
      : { ic: 'bag', t: 'Готов к выдаче', s: `Заберите: ${loc.name}, ${loc.street}` },
    cancelled ? { ic: 'ban', t: 'Отменён', s: 'Свяжитесь с нами, если это ошибка' } : { ic: 'check', t: 'Выполнен', s: 'Приятного аппетита!' },
  ];
  return `<div class="steps">${steps.map((st, i) => {
    const idx = i + 1;
    const cls = idx < cur || (idx === 4 && cur === 4) ? 'done' : idx === cur ? 'active' : '';
    return `<div class="step ${cls}"><div class="step-dot">${icon(cls === 'done' ? 'check' : st.ic)}</div>
      <div><div class="step-title">${esc(st.t)}</div><div class="step-sub">${esc(st.s)}</div></div></div>`;
  }).join('')}</div>`;
}

function render() {
  if (!dlg) return;
  const focusId = document.activeElement?.id;
  const orders = S.myOrders();
  if (!orders.length) { closeModal(dlg); return; }
  if (!orders.find(o => o.orderNumber === activeNum)) activeNum = orders[0].orderNumber;
  const o = orders.find(x => x.orderNumber === activeNum);
  const closed = [ST.DONE, ST.CANCELLED].includes(o.status);
  dlg.querySelector('.modal-box').innerHTML = `
    <div class="modal-head">
      <div style="flex:1"><h2 class="modal-title">Заказ № ${esc(o.orderNumber)}</h2>
        <p class="modal-sub">${o.type === 'delivery' ? 'Доставка' : 'Самовывоз'} · ${money(o.grandTotal || 0)} · оформлен в ${fmtTime(o.savedAt)}</p></div>
      <button class="modal-close" type="button" data-close aria-label="Закрыть">${icon('x')}</button>
    </div>
    ${orders.length > 1 ? `<div class="track-tabs">${orders.map(x => `<button type="button" class="chip${x.orderNumber === activeNum ? ' on' : ''}" data-num="${esc(x.orderNumber)}">№ ${esc(x.orderNumber)}</button>`).join('')}</div>` : ''}
    <div class="modal-body">
      ${stepsHtml(o)}
      <div class="kv">
        <div>${icon('user')}<span>${esc(o.name || '')} · ${esc(o.phone || '')}</span></div>
        ${o.type === 'delivery' ? `<div>${icon('pin')}<span>${esc(o.address || '')}</span></div>` : ''}
        ${(o.items || []).map(i => `<div>${icon('dot')}<span style="flex:1">${esc(i.name)} × ${i.qty}</span><span class="tnum">${money(i.price * i.qty)}</span></div>`).join('')}
        ${(() => { const items = (o.items || []).reduce((a, i) => a + i.price * i.qty, 0); const fee = (o.grandTotal || 0) - items; return fee > 0 ? `<div>${icon('scooter')}<span style="flex:1">Доставка</span><span class="tnum">${money(fee)}</span></div>` : ''; })()}
      </div>
    </div>
    <div class="modal-foot">
      ${closed
        ? `<button class="btn btn--ghost btn--lg btn--block" type="button" id="trForget">${icon('check')} Скрыть заказ</button>`
        : [ST.ON_WAY, ST.READY].includes(o.status)
          ? `<button class="btn btn--primary btn--lg btn--block" type="button" id="trGot">${icon('bag')} Я получил заказ</button>`
          : `<p class="faint" style="text-align:center;width:100%;font-size:13px">Мы сообщим, когда заказ будет ${o.type === 'delivery' ? 'в пути' : 'готов'}</p>`}
    </div>`;
  dlg.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeModal(dlg));
  if (focusId && dlg.querySelector('#' + focusId)) dlg.querySelector('#' + focusId).focus();
  dlg.querySelectorAll('[data-num]').forEach(b => b.onclick = () => { activeNum = Number(b.dataset.num) || b.dataset.num; render(); poll(); });
  $('#trForget', dlg)?.addEventListener('click', () => { S.removeMyOrder(o.orderNumber); render(); });
  $('#trGot', dlg)?.addEventListener('click', async () => {
    const yes = await confirmDialog({ title: 'Заказ у вас?', text: 'После подтверждения заказ закроется и исчезнет из отслеживания.', ok: 'Да, получил', cancel: 'Ещё нет', iconName: 'bag' });
    if (!yes) return;
    try {
      await api.confirm(o.loc || S.getLoc(), o.orderNumber);
      S.removeMyOrder(o.orderNumber);
      toast('Приятного аппетита!', { type: 'ok', text: 'Спасибо, что выбрали ИСТОК' });
      render();
    } catch (e) { toast('Не получилось подтвердить', { type: 'err', text: e.message }); }
  });
}

/** Опрос статусов всех активных заказов */
async function poll() {
  const list = S.activeOrders();
  let changed = false;
  await Promise.all(list.map(async o => {
    try {
      const d = await api.track(o.loc || S.getLoc(), o.orderNumber);
      if (d?.status && d.status !== o.status) {
        S.updateMyOrder(o.orderNumber, { status: d.status });
        changed = true;
        if (!dlg) toast(`Заказ № ${o.orderNumber}: ${d.status.toLowerCase()}`, { type: d.status === ST.CANCELLED ? 'warn' : 'info', icon: 'bell' });
      }
    } catch (e) {
      if (e.status === 404) { S.removeMyOrder(o.orderNumber); changed = true; }
    }
  }));
  if (dlg && changed) render();       // перерисовываем только при изменениях — фокус не теряется
}

export function openTracking() {
  if (!S.myOrders().length) return;
  if (dlg) return;
  dlg = createModal('', { className: 'tracking' });
  dlg.addEventListener('closed', () => { dlg.remove(); dlg = null; M.lockScroll(false); });
  render();
  M.lockScroll(true);
  openModal(dlg);
  poll();
}

function updateButton() {
  const act = S.activeOrders();
  const btn = $('#trackBtn');
  btn.classList.toggle('show', act.length > 0);
  $('#trackBtnLabel').textContent = act.length > 1 ? `Заказы · ${act.length}` : act[0] ? (act[0].status === ST.NEW ? 'Заказ принят' : act[0].status) : 'Ваш заказ';
}

export function initTracking() {
  $('#trackBtn').addEventListener('click', openTracking);
  S.on('orders', updateButton);
  S.on('open-tracking', openTracking);
  updateButton();
  poll();
  clearInterval(timer);
  timer = setInterval(() => { if (S.activeOrders().length || dlg) poll(); }, 7000);
}
