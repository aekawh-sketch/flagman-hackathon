// ═══════════════════════════════════════════════════════════════
//  Панель — вход: логин и пароль (из Флагмана) → место работы (ресторан и точка) → раздел
//  Панель общая для ресторанов Флагмана: ИСТОК и любой другой, куда человека пригласили.
// ═══════════════════════════════════════════════════════════════
import { $, $$, esc, store } from '../../shared/js/utils.js';
import { icon, themeToggleButton, wireThemeToggles } from '../../shared/js/ui.js';
import { mountLogos, logoMarkup } from '../../shared/js/logo.js';
import { api, resolveMode } from '../../shared/js/api.js';
import { CONFIG } from '../../shared/js/config.js';
import { pagesFor, placeOf, ROLE_RU } from './shell.js';

const COLORS = { kassir: '#3FB37F', ofick: '#F2B33D', courier: '#5B9CF5', spisanie: '#E5484D', accounting: '#A78BFA' };
const params = new URLSearchParams(location.search);
const back = params.get('back');
const goBack = () => back && /^[\w-]+\.html(\?.*)?$/.test(back);

mountLogos();
$('#themeSlot').outerHTML = themeToggleButton();
wireThemeToggles();
$('#artMark').innerHTML = logoMarkup({ className: 'big-mark' });
animateMark();

function setStep(n) { $$('#steps i').forEach((el, i) => el.classList.toggle('on', i < n)); }

function shake(input) {
  input.setAttribute('aria-invalid', 'true');
  const box = input.closest('.pwd') || input;
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
}

async function stepLogin() {
  setStep(1);
  const mode = await resolveMode();
  $('#stage').innerHTML = `<form class="step-anim" id="pwdForm" style="display:flex;flex-direction:column;gap:16px" novalidate>
    <div><h2>Вход сотрудника</h2><p class="muted" style="margin-top:6px">Ресторан и точку выберете после входа</p></div>
    <input class="input" id="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Логин" aria-label="Логин">
    <div class="pwd">
      <input class="input" id="pwd" type="password" autocomplete="current-password" placeholder="Пароль" aria-label="Пароль">
      <button type="button" id="eye" aria-label="Показать пароль">${icon('eye')}</button>
    </div>
    <div class="field-error" id="err" hidden></div>
    ${mode === 'mock'
      ? `<div class="hint-box">Демо-режим: бэкенд не подключён. Логин любой, пароль — <b>${esc(CONFIG.MOCK_PASSWORD)}</b></div>`
      : `<p class="faint" style="font-size:13px">Логин и пароль — те же, что во «Флагмане»: их выдаёт админ ресторана. Работаете в нескольких ресторанах — выберете, в каком сейчас.</p>`}
    <button class="btn btn--primary btn--lg btn--block" type="submit" id="go">Войти ${icon('arrowRight')}</button>
  </form>`;
  const inp = $('#pwd');
  const loginInp = $('#login');
  loginInp.value = store.get('istok_panel_login') || '';
  setTimeout(() => (loginInp.value ? inp : loginInp).focus(), 100);
  $('#eye').onclick = () => {
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#eye').innerHTML = icon(show ? 'eyeOff' : 'eye');
  };
  $('#pwdForm').onsubmit = async e => {
    e.preventDefault();
    if (!inp.value) { inp.focus(); return; }
    const btn = $('#go');
    btn.classList.add('is-loading');
    try {
      const login = loginInp.value.trim();
      const r = await api.login(login, inp.value);
      if (login) store.set('istok_panel_login', login);
      if (r.user) entered(r.user);
      else stepPlace(r.workplaces || [], r.person);
    } catch (ex) {
      btn.classList.remove('is-loading');
      const err = $('#err');
      err.hidden = false;
      err.textContent = ex.status === 0 ? 'Сервер недоступен' : (ex.message || 'Неверный логин или пароль');
      inp.value = '';
      shake(inp);
      inp.focus();
    }
  };
}

/** Где человек сейчас работает: рестораны (роль в каждом) и их точки. */
function stepPlace(workplaces, person) {
  setStep(2);
  const last = store.get('istok_panel_loc');
  $('#stage').innerHTML = `<div class="step-anim" style="display:flex;flex-direction:column;gap:18px">
    <div><h2>Где вы сейчас работаете?</h2><p class="muted" style="margin-top:6px">${esc(person?.name || '')}${person?.name ? ' · ' : ''}выберите ресторан и точку</p></div>
    ${workplaces.map(w => `<div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
        <b style="font-size:15px">${esc(w.tenantName)}</b><span class="faint" style="font-size:12.5px">${esc(person?.service ? 'служебный вход' : (ROLE_RU[w.role] || w.role))}</span>
      </div>
      <div class="pick-grid">${w.locations.map(l => `
        <button class="pick" type="button" data-loc="${esc(l.id)}" ${l.id === last ? 'style="border-color:var(--brand)"' : ''}>
          <span class="pk-ico">${icon('pin')}</span>
          <span><b>${esc(w.own && CONFIG.LOCATIONS[l.id] ? CONFIG.LOCATIONS[l.id].name : l.name)}</b><span>${esc(w.own && CONFIG.LOCATIONS[l.id] ? CONFIG.LOCATIONS[l.id].street : w.tenantName)}</span></span>${icon('arrowRight')}
        </button>`).join('')}</div>
    </div>`).join('')}
    <div class="field-error" id="err" hidden></div>
    <button type="button" class="btn btn--ghost" id="logout">${icon('logout')} Выйти</button>
  </div>`;
  $$('[data-loc]').forEach(b => b.onclick = async () => {
    $$('[data-loc]').forEach(x => { x.disabled = true; });
    try {
      entered((await api.workplace(b.dataset.loc)).user);
    } catch (ex) {
      $$('[data-loc]').forEach(x => { x.disabled = false; });
      if (ex.status === 401) { stepLogin(); return; }
      const err = $('#err');
      err.hidden = false;
      err.textContent = ex.status === 0 ? 'Сервер недоступен' : ex.message;
    }
  });
  $('#logout').onclick = logout;
}

function entered(user) {
  store.set('istok_panel_loc', user.loc);
  if (goBack()) { location.href = back; return; }
  stepPanel(user);
}

async function logout() {
  try { await api.logout(); } catch {}
  stepLogin();
}

function stepPanel(user) {
  setStep(3);
  const L = placeOf(user, user.loc);
  const who = `${esc(user.name)} · ${esc(user.service ? 'служебный вход' : (ROLE_RU[user.role] || user.role))}`;
  const pages = pagesFor(user);
  $('#stage').innerHTML = `<div class="step-anim" style="display:flex;flex-direction:column;gap:18px">
    <div><h2>Куда идём?</h2><p class="muted" style="margin-top:6px">${who} · ${esc(L.label)}${user.multi ? ` · <button type="button" class="link" id="chPlace">сменить</button>` : ''}</p></div>
    ${pages.length ? '' : '<div class="hint-box">Для вашей роли в панели нет разделов — спросите админа ресторана.</div>'}
    <div class="pick-grid">${pages.map(p => `
      <a class="pick" href="${p.href}?loc=${encodeURIComponent(user.loc)}" style="--c:${COLORS[p.id]}">
        <span class="pk-ico">${icon(p.icon)}</span>
        <span><b>${esc(p.title)}</b><span>${esc(p.desc)}</span></span>${icon('arrowRight')}
      </a>`).join('')}</div>
    <button type="button" class="btn btn--ghost" id="logout">${icon('logout')} Выйти</button>
  </div>`;
  $('#chPlace')?.addEventListener('click', async () => {
    const s = await api.session();
    if (s.person) stepPlace(s.workplaces, s.person); else stepLogin();
  });
  $('#logout').onclick = logout;
}

function animateMark() {
  const svg = $('#artMark svg');
  if (!svg || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ring = svg.querySelector('.lg-ring'), sun = svg.querySelector('.lg-sun'), field = svg.querySelector('.lg-field');
  const len = 2 * Math.PI * 315;
  ring.style.strokeDasharray = len;
  ring.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'both' });
  sun.animate([{ transform: 'translateY(260px)' }, { transform: 'translateY(0)' }], { duration: 1200, delay: 400, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
  field.animate([{ transform: 'translateY(120px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 1000, delay: 600, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
  // «дыхание» солнца
  setTimeout(() => sun.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-14px)' }, { transform: 'translateY(0)' }], { duration: 5000, iterations: Infinity, easing: 'ease-in-out' }), 1700);
}

// Старт: уже в панели — к разделам (или обратно на страницу); вошёл без места работы или «сменить» — выбор места
(async () => {
  const s = await api.session();
  if (s.user && params.get('step') !== 'place') {
    if (goBack()) { location.replace(back); return; }
    stepPanel(s.user);
  } else if (s.person) stepPlace(s.workplaces, s.person);
  else stepLogin();
})();
