// ═══════════════════════════════════════════════════════════════
//  Панель — СПИСАНИЕ: пролитый напиток, бой, порча — с фото и личным PIN.
//  Заявка уходит в склад «Флагман» от имени сотрудника: напиток или блюдо
//  списывается по техкарте, продукт — по партиям FEFO. Заявку повара и
//  кассира подписывает управляющий; пока ждёт — эти продукты не продаются.
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, money, store } from '../../shared/js/utils.js';
import { icon, toast } from '../../shared/js/ui.js';
import { api, resolveMode } from '../../shared/js/api.js';
import { initShell } from './shell.js';
import { enhanceSelect } from '../../shared/js/picker.js';
import { openPhoto } from './photoview.js';

const shell = await initShell({ page: 'spisanie', title: 'Списание' });
const { loc, L } = shell;

const ROLE = { COOK: 'повар', CASHIER: 'кассир', STOREKEEPER: 'кладовщик', MANAGER: 'управляющий' };
const UNIT = { G: 'г', ML: 'мл', PCS: 'шт' };
const REASONS = [['DAMAGED', 'Пролито, разбито, брак'], ['SPOILED', 'Испортилось'], ['OTHER', 'Другое']];
const HISTORY = `istok_writeoffs_${loc}`;
const S = { form: null, menu: null, kind: 'dish', reason: 'DAMAGED', photos: [], size: 0, variant: 0 };
const MAX_PHOTOS = 10;

$('#content').innerHTML = `
  <div class="page-head">
    <div><h1>Списание</h1><p>${esc(L.name)} · пролитый напиток, бой, порча — с фото и личным PIN</p></div>
  </div>
  <div id="woBody"><div class="card" style="padding:24px"><div class="skeleton" style="height:240px"></div></div></div>`;

if ((await resolveMode()) !== 'real') {
  $('#woBody').innerHTML = `<div class="card"><div class="empty">${icon('warehouse')}
    <div class="empty-title">Списание работает только со складом «Флагман»</div>
    <div>В демо-режиме без сервера заявки отправлять некуда.</div></div></div>`;
} else {
  try {
    [S.form, S.menu] = await Promise.all([api.writeoffForm(loc), api.menu(loc)]);
    render();
  } catch (e) {
    $('#woBody').innerHTML = `<div class="card"><div class="empty">${icon('alert')}
      <div class="empty-title">Не удалось загрузить</div><div>${esc(e.message)}</div></div></div>`;
  }
}

// ═══════════════════════════════════════════════════════════════
//  ФОРМА
// ═══════════════════════════════════════════════════════════════
function render() {
  const staff = S.form.staff;
  $('#woBody').innerHTML = `
    <div class="wo-grid">
      <form class="card wo-form" id="woForm" novalidate>
        <div id="woResult"></div>
        <section class="wo-sec">
          <h3><span class="wo-n">1</span> Кто списывает</h3>
          <div class="wo-row">
            <label class="field" style="flex:2;min-width:200px"><span class="field-label">Сотрудник</span>
              <select class="select" id="woUser"><option value="">Выберите себя</option>
                ${staff.map(u => `<option value="${u.id}" data-hint="${esc(ROLE[u.role] || u.role)}">${esc(u.name)}</option>`).join('')}</select></label>
            <label class="field" style="flex:1;min-width:120px"><span class="field-label">Личный PIN</span>
              <input class="input" id="woPin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="••••"></label>
          </div>
          <p class="faint wo-note">Заявка уйдёт во «Флагман» от вашего имени: PIN — ваша подпись.</p>
        </section>
        <section class="wo-sec">
          <h3><span class="wo-n">2</span> Что списываем</h3>
          <div class="segmented" id="woKind">
            <button type="button" data-k="dish" aria-pressed="true">${icon('flame')} Напиток или блюдо</button>
            <button type="button" data-k="product" aria-pressed="false">${icon('box')} Продукт со склада</button>
          </div>
          <div id="woWhat"></div>
        </section>
        <section class="wo-sec">
          <h3><span class="wo-n">3</span> Причина и фото</h3>
          <div class="segmented wo-wrap" id="woReason">${REASONS.map(([k, t]) =>
            `<button type="button" data-r="${k}" aria-pressed="${k === S.reason}">${t}</button>`).join('')}</div>
          <label class="field"><span class="field-label">Комментарий <span class="faint" id="woCReq">(по желанию)</span></span>
            <textarea class="textarea" id="woC" rows="2" maxlength="300" placeholder="Например: гость задел стакан, латте пролился"></textarea></label>
          <div class="wo-photos" id="woPhotos"></div>
          <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" id="woCam" hidden>
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple id="woGal" hidden>
        </section>
        <div class="wo-err" id="woErr" hidden></div>
        <div class="wo-foot">
          <span class="faint">Заявку подписывает управляющий или админ. Пока ждёт — эти продукты не продаются.</span>
          <button class="btn btn--primary btn--lg" type="submit" id="woGo">${icon('trash')} Отправить заявку</button>
        </div>
      </form>
      <aside class="card">
        <div class="card-h"><h3>Отправлено с этого устройства</h3></div>
        <div id="woHist"></div>
      </aside>
    </div>`;

  enhanceSelect($('#woUser'), { search: S.form.staff.length >= 9 });
  $('#woKind').onclick = e => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    S.kind = b.dataset.k;
    $$('#woKind [data-k]').forEach(x => x.setAttribute('aria-pressed', x === b));
    renderWhat();
  };
  $('#woReason').onclick = e => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    S.reason = b.dataset.r;
    $$('#woReason [data-r]').forEach(x => x.setAttribute('aria-pressed', x === b));
    $('#woCReq').textContent = S.reason === 'OTHER' ? '(обязательно для «Другое»)' : '(по желанию)';
  };
  // Несколько фото: «Снять» — камера, «Добавить» — галерея (сразу несколько). Крестик — убрать.
  const addPhotos = async e => {
    const files = [...(e.target.files || [])].slice(0, MAX_PHOTOS - S.photos.length);
    e.target.value = '';
    for (const f of files) {
      try { S.photos.push(await shrink(f)); } catch { toast('Не удалось прочитать фото', { type: 'err', text: f.name }); }
    }
    renderPhotos();
  };
  $('#woCam').onchange = addPhotos;
  $('#woGal').onchange = addPhotos;
  $('#woPhotos').onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { S.photos.splice(Number(rm.dataset.rm), 1); return renderPhotos(); }
    const z = e.target.closest('[data-zoom]');
    if (z) return openPhoto(S.photos[Number(z.dataset.zoom)], `Фото ${Number(z.dataset.zoom) + 1} из ${S.photos.length}`);
    if (e.target.closest('[data-cam]')) $('#woCam').click();
    if (e.target.closest('[data-gal]')) $('#woGal').click();
  };
  renderPhotos();
  $('#woForm').onsubmit = submit;
  $('#woForm').oninput = () => { $('#woErr').hidden = true; };
  renderWhat();
  renderHistory();
}

/** Второй шаг: напиток/блюдо из меню (по техкарте) или продукт со склада (по партиям FEFO). */
function renderWhat() {
  if (S.kind === 'dish') {
    const byCat = S.menu.categories.map(c => ({ c, items: S.menu.items.filter(i => i.cat === c.id && i.cat !== 'sets') }))
      .filter(g => g.items.length);
    $('#woWhat').innerHTML = `
      <div class="wo-row">
        <label class="field" style="flex:3;min-width:220px"><span class="field-label">Напиток или блюдо</span>
          <select class="select" id="woItem"><option value="">Выберите из меню</option>
            ${byCat.map(g => `<optgroup label="${esc(g.c.name)}">${g.items.map(i =>
              `<option value="${i.id}" data-hint="${i.available === false ? 'в стопе' : ''}">${esc(i.name)}</option>`).join('')}</optgroup>`).join('')}
          </select></label>
        <label class="field" style="flex:1;min-width:110px"><span class="field-label">Порций</span>
          <input class="input" id="woPortions" type="number" min="1" max="50" value="1" inputmode="numeric"></label>
      </div>
      <div id="woOpts"></div>
      <p class="faint wo-note">Спишутся все продукты по техкарте — например, для латте: кофе, молоко, сироп.</p>`;
    enhanceSelect($('#woItem'));
    $('#woItem').onchange = renderOpts;
  } else {
    const groups = {};
    S.form.products.forEach(p => (groups[p.category] ||= []).push(p));
    $('#woWhat').innerHTML = `
      <div class="wo-row">
        <label class="field" style="flex:3;min-width:220px"><span class="field-label">Продукт</span>
          <select class="select" id="woProd"><option value="">Выберите продукт</option>
            ${Object.entries(groups).map(([c, ps]) => `<optgroup label="${esc(c)}">${ps.map(p =>
              `<option value="${p.id}" data-hint="${p.availableText ? `есть ${esc(p.availableText)}` : ''}">${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}
          </select></label>
        <label class="field" style="flex:1;min-width:130px"><span class="field-label">Количество, <span id="woUnit">г</span></span>
          <input class="input" id="woQty" type="number" min="1" inputmode="numeric" placeholder="0"></label>
      </div>
      <p class="faint wo-note">Партию выберет склад: сначала та, у которой срок ближе (FEFO).</p>`;
    enhanceSelect($('#woProd'));
    $('#woProd').onchange = () => {
      const p = S.form.products.find(x => x.id === $('#woProd').value);
      $('#woUnit').textContent = p ? UNIT[p.unit] : 'г';
    };
  }
}

/** Размер или вид напитка/блюда — как в кассе. */
function renderOpts() {
  const it = S.menu.items.find(i => i.id === $('#woItem').value);
  S.size = 0;
  S.variant = 0;
  const sizes = it?.price2 ? (it.pizza ? ['30 см', '40 см'] : it.sizes) : null;
  $('#woOpts').innerHTML = !it ? '' : `
    ${it.variantOpts ? `<div class="segmented wo-wrap" id="woVar">${it.variantOpts.map((v, i) =>
      `<button type="button" data-v="${i}" aria-pressed="${i === 0}">${esc(v)}</button>`).join('')}</div>` : ''}
    ${sizes ? `<div class="segmented wo-wrap" id="woSize">${sizes.map((s, i) =>
      `<button type="button" data-s="${i}" aria-pressed="${i === 0}">${esc(s)}</button>`).join('')}</div>` : ''}`;
  $('#woOpts').onclick = e => {
    const v = e.target.closest('[data-v]'), s = e.target.closest('[data-s]');
    if (v) { S.variant = Number(v.dataset.v); $$('[data-v]', $('#woOpts')).forEach(x => x.setAttribute('aria-pressed', x === v)); }
    if (s) { S.size = Number(s.dataset.s); $$('[data-s]', $('#woOpts')).forEach(x => x.setAttribute('aria-pressed', x === s)); }
  };
}

// ═══════════════════════════════════════════════════════════════
//  ОТПРАВКА
// ═══════════════════════════════════════════════════════════════
async function submit(e) {
  e.preventDefault();
  const err = msg => { $('#woErr').hidden = false; $('#woErr').textContent = msg; };
  const userId = $('#woUser').value, pin = $('#woPin').value.trim();
  if (!userId) return err('Выберите себя в списке сотрудников');
  if (!/^\d{4,6}$/.test(pin)) return err('Введите личный PIN — 4–6 цифр');
  const payload = { userId: Number(userId), pin, reason: S.reason, comment: $('#woC').value.trim(), photos: S.photos, kind: S.kind };
  let what;
  if (S.kind === 'dish') {
    const it = S.menu.items.find(i => i.id === $('#woItem').value);
    if (!it) return err('Выберите напиток или блюдо');
    payload.itemId = it.id;
    payload.size = S.size;
    payload.variant = S.variant;
    payload.portions = Math.max(1, Math.min(50, parseInt($('#woPortions').value) || 1));
    const opt = it.variantOpts?.[S.variant] || (it.price2 ? (it.pizza ? ['30 см', '40 см'] : it.sizes)?.[S.size] : '');
    what = `${it.name}${opt ? ` (${opt.toLowerCase()})` : ''} ×${payload.portions}`;
  } else {
    const p = S.form.products.find(x => x.id === $('#woProd').value);
    const qty = Math.round(Number($('#woQty').value));
    if (!p) return err('Выберите продукт');
    if (!(qty > 0)) return err('Укажите количество');
    if (p.available != null && qty > p.available) return err(`На складе только ${p.availableText}`);
    payload.productId = p.id;
    payload.qty = qty;
    what = `${p.name} ${qty} ${UNIT[p.unit]}`;
  }
  if (S.reason === 'OTHER' && !payload.comment) return err('Для причины «Другое» напишите комментарий');
  if (!S.photos.length) return err('Сфотографируйте то, что списываете');

  const btn = $('#woGo');
  btn.classList.add('is-loading');
  btn.disabled = true;
  try {
    const r = await api.writeoff(loc, payload);
    const who = $('#woUser').selectedOptions[0].textContent;
    showResult(r, what, who);
    saveHistory({ at: new Date().toISOString(), what, who, status: r.status, cost: r.costKop, reason: S.reason });
    // PIN и фото — только для одной заявки
    $('#woPin').value = '';
    $('#woC').value = '';
    S.photos = [];
    renderPhotos();
    S.form = await api.writeoffForm(loc).catch(() => S.form);   // остатки изменились — обновить «есть …»
    if (S.kind === 'product') renderWhat();
  } catch (ex) {
    err(ex.message || 'Не удалось отправить заявку');
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

function showResult(r, what, who) {
  const pending = r.needsApproval;
  $('#woResult').innerHTML = `
    <div class="wo-result ${pending ? 'pending' : 'done'}" role="status">
      <div class="wo-result-h">${icon(pending ? 'hourglass' : 'check')}
        <b>${pending ? 'Заявка отправлена управляющему на подпись' : 'Списано'}</b><span>${money(Math.round(r.costKop / 100))}</span></div>
      <div class="muted">${esc(what)} · ${esc(who)}</div>
      <ul>${(r.lines || []).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      ${pending ? '<div class="faint">Пока заявка ждёт, эти продукты не продаются. Подпись — во Флагмане, раздел «Заявки на списание».</div>' : ''}
    </div>`;
  $('#woResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(pending ? 'Заявка ждёт подписи' : 'Списано', { type: 'ok', text: what });
}

// ═══════════════════════════════════════════════════════════════
//  ИСТОРИЯ (только на этом устройстве) И ФОТО
// ═══════════════════════════════════════════════════════════════
function saveHistory(h) {
  store.set(HISTORY, [h, ...(store.get(HISTORY) || [])].slice(0, 15));
  renderHistory();
}

function renderHistory() {
  const list = store.get(HISTORY) || [];
  const reason = Object.fromEntries(REASONS);
  $('#woHist').innerHTML = list.length ? `<div class="list">${list.map(h => `
    <div class="li"><span class="li-ico ${h.status === 'PENDING' ? 'hot' : 'ok'}">${icon(h.status === 'PENDING' ? 'hourglass' : 'check')}</span>
      <div class="li-body"><div class="li-title"><span class="grow">${esc(h.what)}</span><span class="li-right strong">${money(Math.round((h.cost || 0) / 100))}</span></div>
        <div class="li-sub">${esc(h.who)} · ${esc(reason[h.reason] || '')} · ${new Date(h.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          · ${h.status === 'PENDING' ? 'ждала подписи' : 'списано'}</div></div></div>`).join('')}</div>`
    : `<div class="empty" style="padding:26px">${icon('trash')}<div>Здесь появятся заявки, отправленные с этого устройства</div></div>`;
}

/** Фото с телефона весит мегабайты — ужимаем до 1600 px по длинной стороне (JPEG). */
/** Фото заявки: миниатюры с приближением и крестиком, плитки «Снять» и «Добавить», пока меньше 10. */
function renderPhotos() {
  const box = $('#woPhotos');
  if (!box) return;
  const tiles = S.photos.length < MAX_PHOTOS
    ? `<button type="button" class="wo-add" data-cam>${icon('camera')}<b>Снять</b></button>
       <button type="button" class="wo-add" data-gal>${icon('plus')}<b>Добавить</b></button>` : '';
  box.innerHTML = S.photos.map((p, i) => `<div class="wo-ph">
      <button type="button" class="wo-zoom" data-zoom="${i}" aria-label="Открыть фото ${i + 1} крупно"><img src="${p}" alt="Фото ${i + 1}"></button>
      <button type="button" class="wo-rm" data-rm="${i}" aria-label="Убрать фото ${i + 1}">${icon('x')}</button></div>`).join('') + tiles
    + `<span class="faint wo-ph-hint">${S.photos.length ? `${S.photos.length} из ${MAX_PHOTOS} · нажмите, чтобы приблизить`
      : 'Обязательно хотя бы одно фото — можно несколько, до 10'}</span>`;
}

/** Фото для заявки: до 2560 px по длинной стороне — деталь видна, а заявка не весит десятки мегабайт. */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 2560 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
