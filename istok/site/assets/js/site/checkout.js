// ═══════════════════════════════════════════════════════════════
//  Сайт — выбор варианта блюда и оформление заказа
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, num, money, bindPhoneMask, phoneDigits, plural } from '../../../shared/js/utils.js';
import { icon, toast, createModal, openModal, closeModal } from '../../../shared/js/ui.js';
import { api } from '../../../shared/js/api.js';
import { CONFIG } from '../../../shared/js/config.js';
import { photoUrl } from '../../../shared/js/menu-catalog.js';
import * as S from './state.js';
import * as M from './motion.js';

// ═══ Выбор варианта / размера ═════════════════════════════════
/** «250/800мл» → ['250 мл', '800 мл'] (единица берётся из последнего сегмента) */
function splitWeights(w) {
  const parts = String(w || '').split('/').map(x => x.trim()).filter(Boolean);
  const unit = (parts[parts.length - 1] || '').replace(/[\d\s.,]/g, '');
  return parts.map(p => (/\D$/.test(p) ? p.replace(/(\d)([^\d\s])/, '$1 $2') : `${p} ${unit}`).trim());
}

export function openPicker(it, { onAdd }) {
  const vAvail = it.variants_available || null;
  let variant = vAvail ? Math.max(0, vAvail.indexOf(true)) : 0;
  let size = 0;
  const sizes = it.price2 ? (it.pizza ? ['30 см', '40 см'] : it.sizes || null) : null;
  const weights = splitWeights(it.weight);
  const sizeIsVolume = sizes && sizes.every(s => /\d/.test(s));
  const weightFor = i => weights.length > 1 ? weights[i] : weights[0] || '';
  const src = it.photo && it.photo !== 'default' ? photoUrl(it.photo, 900, 560) : '';
  const d = createModal(`
    <div class="picker-img">${src ? `<img src="${src}" alt="">` : `<div class="ph" style="position:absolute;inset:0;background:var(--surface-2)"></div>`}
      <button class="modal-close" type="button" data-close aria-label="Закрыть">${icon('x')}</button></div>
    <div class="modal-body" style="padding-top:20px">
      <h2 class="modal-title">${esc(it.name)}</h2>
      <p class="modal-sub">${esc(it.desc || '')}</p>
      ${it.variantOpts ? `<div class="opt-label">Вариант</div>
        <div class="opts" role="radiogroup" aria-label="Вариант">${it.variantOpts.map((v, i) => {
          const off = vAvail && !vAvail[i];
          return `<button type="button" class="opt" role="radio" aria-checked="${i === variant}" data-v="${i}" ${off ? 'disabled' : ''}><b>${esc(v)}</b>${off ? '<span>нет сегодня</span>' : ''}</button>`;
        }).join('')}</div>` : ''}
      ${sizes ? `<div class="opt-label">${sizeIsVolume ? 'Размер' : 'Молоко'}</div>
        <div class="opts" role="radiogroup" aria-label="${sizeIsVolume ? 'Размер' : 'Молоко'}">${sizes.map((s, i) => {
          const w = weightFor(i);
          const showW = w && !s.replace(/\s/g, '').includes(w.replace(/\s/g, ''));
          return `<button type="button" class="opt" role="radio" aria-checked="${i === 0}" data-s="${i}"><b>${esc(s)}</b><span>${num(i ? it.price2 : it.price)} ₽${showW ? ' · ' + esc(w) : ''}</span></button>`;
        }).join('')}</div>` : ''}
    </div>
    <div class="modal-foot">
      <div style="display:flex;flex-direction:column;justify-content:center;flex:1"><span class="faint" style="font-size:12px" id="pkWeight">${esc(weightFor(0))}</span><b style="font-size:1.4rem" id="pkPrice">${num(it.price)} ₽</b></div>
      <button class="btn btn--primary btn--lg" type="button" id="pkAdd" ${it.available === false ? 'disabled' : ''}>${it.available === false ? 'Нет в наличии' : `${icon('plus')} В корзину`}</button>
    </div>`, { className: 'picker' });
  const update = () => {
    $('#pkPrice', d).textContent = `${num(size ? it.price2 : it.price)} ₽`;
    $('#pkWeight', d).textContent = weightFor(size);
  };
  d.addEventListener('click', e => {
    const v = e.target.closest('[data-v]:not([disabled])'), s = e.target.closest('[data-s]');
    if (v) { variant = Number(v.dataset.v); $$('[data-v]', d).forEach(b => b.setAttribute('aria-checked', b === v)); }
    if (s) { size = Number(s.dataset.s); $$('[data-s]', d).forEach(b => b.setAttribute('aria-checked', b === s)); update(); }
  });
  $('#pkAdd', d).addEventListener('click', e => {
    onAdd(size, variant, $('.picker-img img', d) || e.currentTarget);
    closeModal(d);
  });
  d.addEventListener('closed', () => { d.remove(); M.lockScroll(false); });
  M.lockScroll(true);
  openModal(d);
}

// ═══ Оформление ═══════════════════════════════════════════════
let type = 'delivery';
let payment = 'card';

export function openCheckout() {
  if (!S.getCart().length) { toast('Корзина пуста', { type: 'warn' }); return; }
  const loc = S.getLoc();
  const L = CONFIG.LOCATIONS;
  const d = createModal(`
    <div class="modal-head">
      <div style="flex:1"><h2 class="modal-title">Оформление</h2><p class="modal-sub">Осталась пара шагов — и мы начнём готовить</p></div>
      <button class="modal-close" type="button" data-close aria-label="Закрыть">${icon('x')}</button>
    </div>
    <form class="modal-body" id="coForm" novalidate>
      <div class="form-grid">
        <div class="field">
          <span class="field-label">Город <span class="req">*</span></span>
          <div class="choice-row" role="radiogroup" aria-label="Город" data-group="loc">
            ${Object.values(L).map(l => `<button type="button" class="choice" role="radio" aria-checked="${l.code === loc}" data-loc="${l.code}">${icon('pin')}<b>${esc(l.name)}</b><span>${esc(l.street)}</span></button>`).join('')}
          </div>
          <span class="field-error" id="errLoc" hidden>Выберите город</span>
        </div>
        <div class="field">
          <span class="field-label">Как получить</span>
          <div class="choice-row" role="radiogroup" aria-label="Способ получения" data-group="type">
            <button type="button" class="choice" role="radio" aria-checked="${type === 'delivery'}" data-type="delivery">${icon('scooter')}<b>Доставка</b><span>${CONFIG.DELIVERY.eta} · бесплатно от ${num(CONFIG.DELIVERY.freeFrom)} ₽</span></button>
            <button type="button" class="choice" role="radio" aria-checked="${type === 'pickup'}" data-type="pickup">${icon('bag')}<b>Самовывоз</b><span id="pickupAddr">${esc(loc ? L[loc].street : 'Бесплатно')}</span></button>
          </div>
        </div>
        <label class="field">
          <span class="field-label">Ваше имя <span class="req">*</span></span>
          <input class="input" id="coName" autocomplete="name" placeholder="Иван Петров" maxlength="48" aria-describedby="errName" enterkeyhint="next">
          <span class="field-error" id="errName" hidden></span>
        </label>
        <label class="field">
          <span class="field-label">Телефон <span class="req">*</span></span>
          <input class="input" id="coPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (000) 000-00-00" aria-describedby="errPhone" enterkeyhint="next">
          <span class="field-error" id="errPhone" hidden></span>
        </label>
        <div class="field" id="addrField" ${type === 'pickup' ? 'hidden' : ''}>
          <label class="field-label" for="coAddr">Адрес доставки <span class="req">*</span></label>
          <div class="addr-wrap" id="addrWrap"><span class="addr-pre" id="addrPre">${esc(loc ? L[loc].addrPrefix : '')}</span><input class="input" id="coAddr" autocomplete="street-address" placeholder="ул. Пушкина, д. 5, кв. 12" maxlength="60" aria-describedby="errAddr"></div>
          <span class="field-error" id="errAddr" hidden></span>
        </div>
        <div class="field">
          <span class="field-label">Оплата</span>
          <div class="segmented" role="radiogroup" aria-label="Оплата" data-group="pay" style="align-self:flex-start">
            <button type="button" role="radio" aria-checked="${payment === 'card'}" data-pay="card">Картой</button>
            <button type="button" role="radio" aria-checked="${payment === 'cash'}" data-pay="cash">Наличными</button>
          </div>
        </div>
        <label class="field">
          <span class="field-label">Комментарий</span>
          <textarea class="textarea" id="coNote" maxlength="120" rows="2" placeholder="Без лука, домофон 42…"></textarea>
        </label>
        <div id="oosBox" hidden></div>
        <div class="summary" id="coSummary"></div>
      </div>
    </form>
    <div class="modal-foot">
      <button class="btn btn--primary btn--lg btn--block" type="submit" form="coForm" id="coSubmit">Подтвердить заказ</button>
    </div>`, { className: 'checkout' });

  const els = {
    name: $('#coName', d), phone: $('#coPhone', d), addr: $('#coAddr', d), note: $('#coNote', d),
    submit: $('#coSubmit', d), summary: $('#coSummary', d), oos: $('#oosBox', d),
  };
  const err = (id, msg) => { const e = $('#' + id, d); e.hidden = !msg; e.textContent = msg || ''; };

  function renderSummary() {
    const total = S.cartTotal();
    const fee = S.deliveryFee(total, type);
    const cart = S.getCart();
    els.summary.innerHTML = `
      ${cart.map(l => `<div class="summary-row"><span>${esc(l.name)} × ${l.qty}</span><span>${money(l.price * l.qty)}</span></div>`).join('')}
      ${type === 'delivery' ? `<div class="summary-row"><span>Доставка${fee ? '' : ' — бесплатно'}</span><span>${fee ? '+' + money(fee) : '0 ₽'}</span></div>` : ''}
      <div class="summary-total"><span>Итого</span><span>${money(total + fee)}</span></div>`;
    els.submit.innerHTML = `Подтвердить · ${money(total + fee)}`;
    els.submit.disabled = !cart.length;
  }
  renderSummary();

  // Выборы
  d.addEventListener('click', e => {
    const l = e.target.closest('[data-loc]');
    if (l) {
      S.setLoc(l.dataset.loc);
      $$('[data-loc]', d).forEach(b => b.setAttribute('aria-checked', b === l));
      const info = L[l.dataset.loc];
      $('#addrPre', d).textContent = info.addrPrefix;
      $('#pickupAddr', d).textContent = info.street;
      err('errLoc', '');
    }
    const t = e.target.closest('[data-type]');
    if (t) {
      type = t.dataset.type;
      $$('[data-type]', d).forEach(b => b.setAttribute('aria-checked', b === t));
      $('#addrField', d).hidden = type === 'pickup';
      renderSummary();
    }
    const p = e.target.closest('[data-pay]');
    if (p) { payment = p.dataset.pay; $$('[data-pay]', d).forEach(b => b.setAttribute('aria-checked', b === p)); }
  });

  // Ограничения ввода — как на старом сайте
  els.name.addEventListener('input', () => {
    const v = els.name.value.split(' ').slice(0, 3).map(w => w.slice(0, 15)).join(' ');
    if (v !== els.name.value) els.name.value = v;
    els.name.removeAttribute('aria-invalid'); err('errName', '');
  });
  bindPhoneMask(els.phone, { onInput: () => {
    els.phone.removeAttribute('aria-invalid'); err('errPhone', '');
    // номер введён полностью — переходим к следующему полю
    if (phoneDigits(els.phone.value).length === 11) (type === 'delivery' ? els.addr : els.note).focus();
  } });
  els.addr.addEventListener('input', () => { $('#addrWrap', d).classList.remove('invalid'); err('errAddr', ''); });
  const unsub = S.on('cart', () => renderSummary());

  let sending = false;
  $('#coForm', d).addEventListener('submit', async e => {
    e.preventDefault();
    if (sending) return;                 // защита от двойной отправки (Enter + клик)
    const loc = S.getLoc();
    const name = els.name.value.trim().replace(/\s+/g, ' ');
    const phone = els.phone.value.trim();
    const addrSuffix = els.addr.value.trim();
    let bad = null;
    if (!loc) { err('errLoc', 'Выберите город'); bad ||= $('[data-loc]', d); }
    if (name.length < 2) { err('errName', 'Как к вам обращаться?'); els.name.setAttribute('aria-invalid', 'true'); bad ||= els.name; }
    if (phoneDigits(phone).length < 11) { err('errPhone', 'Введите номер полностью'); els.phone.setAttribute('aria-invalid', 'true'); bad ||= els.phone; }
    if (type === 'delivery' && addrSuffix.length < 3) { err('errAddr', 'Укажите улицу и дом'); $('#addrWrap', d).classList.add('invalid'); bad ||= els.addr; }
    if (bad) { bad.focus(); bad.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }

    const blocked = S.unavailableInCart();
    if (blocked.length) { showOos(blocked.map(b => ({ id: b.id, name: b.name, missing: [] }))); return; }

    sending = true;
    els.submit.disabled = true;
    els.submit.classList.add('is-loading');
    const payload = {
      customer: name, phone, type, payment,
      address: type === 'delivery' ? `${CONFIG.LOCATIONS[loc].addrPrefix}${addrSuffix}` : '',
      comment: els.note.value.trim(),
      items: S.getCart().map(l => ({ id: l.id, name: l.name, price: l.price, qty: l.qty, size: l.size, variant: l.variant })),
    };
    try {
      const res = await api.order(loc, payload);
      const items = S.getCart().map(l => ({ name: l.name, qty: l.qty, price: l.price }));
      S.saveMyOrder({
        orderNumber: res.orderNumber, loc, type, status: CONFIG.STATUS.NEW,
        grandTotal: res.grandTotal ?? S.cartTotal() + S.deliveryFee(S.cartTotal(), type),
        name, phone, address: payload.address, items,
      });
      S.clearCart();
      showSuccess(res.orderNumber, res.grandTotal ?? null);
    } catch (ex) {
      sending = false;
      els.submit.disabled = false;
      els.submit.classList.remove('is-loading');
      if (ex.code === 'OUT_OF_STOCK' || ex.status === 409) {
        showOos(ex.data?.unavailable || [], ex.data?.alternatives || []);
        S.emit('refresh-menu');
      } else {
        toast(ex.status === 0 ? 'Сервер недоступен' : 'Не удалось оформить заказ', { type: 'err', text: ex.message });
      }
    }
  });

  function showOos(list, alts = []) {
    // Склад предлагает похожие блюда, которые можно приготовить прямо сейчас
    const shownAlts = alts.filter(a => S.menu.byId[a.id]).slice(0, 4);
    const box = els.oos;
    box.hidden = false;
    const canReduce = list.filter(u => u.max_qty > 0 && u.max_qty < (u.qty || 1));
    box.innerHTML = `<div class="oos-alert" role="alert">
      <h4>${icon('alert')} Не хватает ингредиентов</h4>
      <ul>${list.map(u => `<li>• <span>${esc(u.name)}${u.max_qty > 0 && u.max_qty < (u.qty || 1) ? ` <small>— можно максимум ${u.max_qty}&nbsp;шт.</small>` : u.missing?.length ? ` <small>(закончилось: ${esc(u.missing.map(m => m.name.toLowerCase()).join(', '))})</small>` : ''}</span></li>`).join('') || '<li>Некоторые позиции недоступны</li>'}</ul>
      ${shownAlts.length ? `<div class="oos-alts"><div class="oos-alts-h">Похожее и есть в наличии</div>
        <div class="oos-alts-list">${shownAlts.map((a, i) => `<button type="button" class="btn btn--soft btn--sm" data-alt="${i}">
          ${icon('plus')} ${esc(a.name)} · ${money(a.price)}</button>`).join('')}</div></div>` : ''}
      <div class="oos-acts">
        ${canReduce.length ? `<button type="button" class="btn btn--soft btn--sm" id="oosReduce">Уменьшить количество</button>` : ''}
        <button type="button" class="btn btn--danger btn--sm" id="oosRemove">Убрать ${list.length ? `${list.length} ${plural(list.length, ['позицию', 'позиции', 'позиций'])}` : ''} и продолжить</button>
      </div>
    </div>`;
    const done = () => {
      box.hidden = true;
      if (!S.getCart().length) { closeModal(d); toast('Корзина опустела', { text: 'Выберите что-нибудь другое из меню', type: 'warn' }); }
      else els.submit.focus();
    };
    $('#oosReduce', box)?.addEventListener('click', () => {
      for (const u of canReduce) {
        const line = S.getCart().find(l => l.id === u.id && (l.size || 0) === (u.size || 0) && (l.variant || 0) === (u.variant || 0));
        if (line) S.changeQty(line.key, u.max_qty - line.qty);
      }
      S.removeIds(list.filter(u => !canReduce.includes(u)).map(u => u.id));
      done();
    });
    $('#oosRemove', box).onclick = () => { S.removeIds(list.map(u => u.id)); done(); };
    $$('[data-alt]', box).forEach(b => b.onclick = () => {
      const a = shownAlts[Number(b.dataset.alt)];
      S.addToCart(S.menu.byId[a.id], { size: a.size || 0, variant: a.variant || 0 });
      b.disabled = true;
      b.innerHTML = `${icon('check')} ${esc(a.name)} — в корзине`;
      toast(`Добавлено: ${a.name}`, { type: 'ok' });
    });
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function showSuccess(numb, grand) {
    const info = CONFIG.LOCATIONS[S.getLoc()];
    d.querySelector('.modal-box').innerHTML = `
      <div class="modal-body success">
        <svg class="success-check" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44"/><path d="M30 52 l14 14 l27 -30"/></svg>
        <div class="success-num">№ ${esc(numb)}</div>
        <h2 class="modal-title" style="font-size:1.6rem;margin-top:6px">Заказ принят</h2>
        <p>${type === 'delivery' ? `Доставим за ${CONFIG.DELIVERY.eta}. Курьер позвонит перед приездом.` : `Заберите по адресу: <b>${esc(info.name)}, ${esc(info.street)}</b>.`}${grand ? `<br>Сумма: <b>${money(grand)}</b>` : ''}</p>
        <p class="faint" style="font-size:13px">Вопросы: <a href="tel:${info.phoneTel}">${esc(info.phone)}</a></p>
      </div>
      <div class="modal-foot" style="border:0">
        <button class="btn btn--ghost btn--lg" style="flex:1" type="button" data-close>Отлично</button>
        <button class="btn btn--primary btn--lg" style="flex:1" type="button" id="goTrack">${icon('clock')} Отследить</button>
      </div>`;
    d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(d)));
    $('#goTrack', d).onclick = () => { closeModal(d); setTimeout(() => S.emit('open-tracking'), 250); };
    $('#goTrack', d).focus();
    if (window.gsap) window.gsap.from(d.querySelector('.success'), { y: 20, opacity: 0, duration: 0.6, ease: 'power3.out' });
  }

  d.addEventListener('closed', () => { unsub(); d.remove(); M.lockScroll(false); });
  M.lockScroll(true);
  openModal(d);
  setTimeout(() => (S.getLoc() ? els.name : $('[data-loc]', d))?.focus(), 350);
}
