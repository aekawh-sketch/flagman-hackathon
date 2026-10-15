// ═══════════════════════════════════════════════════════════════
//  Выбор из списка — табличка вместо системного <select>, как во «Флагмане»:
//  пункты крупными строками, подпись справа, группы заголовками, в длинном
//  списке — поиск. Сам <select> остаётся в форме скрытым: значение, событие
//  change, .value и selectedOptions работают как раньше.
//  Подпись справа — data-hint у <option>, группы — <optgroup label>.
//  Пустой <option value=""> — подсказка в поле («Выберите…»), не пункт списка.
// ═══════════════════════════════════════════════════════════════
import { esc } from './utils.js';
import { icon } from './ui.js';

/** Регистр и «ё» не мешают поиску: «еж» найдёт «Ёжик». */
const norm = s => s.toLowerCase().replace(/ё/g, 'е');
/** С какого числа пунктов в поле появляется поиск */
const SEARCH_FROM = 9;

/**
 * @param {HTMLSelectElement} select
 * @param {{ search?: boolean, bare?: boolean }} [opts] bare — без рамки (точка в боковой панели)
 */
export function enhanceSelect(select, { search, bare = false } = {}) {
  if (!select || select._picker) return select?._picker;
  const read = () => [...select.options].map(o => ({
    value: o.value,
    label: o.textContent.trim(),
    hint: o.dataset.hint || '',
    group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '',
    disabled: o.disabled,
  }));
  const placeholder = () => [...select.options].find(o => o.value === '')?.textContent.trim() || 'Выберите…';
  const items = () => read().filter(o => o.value !== '');
  const searchable = search ?? items().length >= SEARCH_FROM;

  const wrap = document.createElement('div');
  wrap.className = `picker${bare ? ' picker--bare' : ''}`;
  wrap.innerHTML = searchable
    ? `<div class="picker-search">${icon('search')}<input class="input picker-trigger" type="text" autocomplete="off" spellcheck="false"
         role="combobox" aria-expanded="false" aria-autocomplete="list"></div>`
    : `<button type="button" class="select picker-trigger" aria-haspopup="listbox" aria-expanded="false"><span class="picker-value"></span></button>`;
  select.after(wrap);
  select.hidden = true;
  const trigger = wrap.querySelector('.picker-trigger');
  const label = select.getAttribute('aria-label') || select.closest('label')?.querySelector('.field-label')?.textContent.trim();
  if (label) trigger.setAttribute('aria-label', label);

  let panel = null, query = '', active = -1, shown = [];

  function refresh() {
    const cur = read().find(o => o.value === select.value && o.value !== '');
    trigger.disabled = select.disabled;
    if (searchable) {
      if (!panel) trigger.value = cur?.label || '';
      trigger.placeholder = cur?.label || placeholder();
    } else {
      const v = trigger.querySelector('.picker-value');
      v.textContent = cur?.label || placeholder();
      v.classList.toggle('is-placeholder', !cur);
    }
  }

  function renderList() {
    const q = norm(query.trim());
    shown = items().filter(o => !q || norm(o.label).includes(q) || norm(o.hint).includes(q) || norm(o.group).includes(q));
    if (!shown.length) { panel.innerHTML = '<div class="picker-empty">Ничего не нашлось</div>'; return; }
    let group = null;
    panel.innerHTML = shown.map((o, i) => {
      const head = o.group && o.group !== group && !q ? `<div class="picker-group">${esc(o.group)}</div>` : '';
      group = o.group;
      return `${head}<button type="button" class="picker-opt${i === active ? ' is-active' : ''}" role="option" data-i="${i}"
        aria-selected="${o.value === select.value}" ${o.disabled ? 'disabled' : ''}>
        <span>${esc(o.label)}</span>${o.hint ? `<span class="picker-hint">${esc(o.hint)}</span>` : ''}</button>`;
    }).join('');
    panel.querySelectorAll('.picker-opt').forEach(b => b.addEventListener('click', () => pick(shown[+b.dataset.i])));
  }

  /** Список — поверх страницы (не обрезается прокруткой), под полем или над ним, если внизу тесно. */
  function place() {
    if (!panel) return;
    const r = wrap.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 240 && above > below;
    const width = Math.min(Math.max(r.width, 240), innerWidth - 16);
    Object.assign(panel.style, {
      left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`, width: `${width}px`,
      top: up ? 'auto' : `${r.bottom + 4}px`, bottom: up ? `${innerHeight - r.top + 4}px` : 'auto',
      maxHeight: `${Math.max(160, Math.min(340, up ? above : below))}px`,
    });
  }

  function open() {
    if (panel || select.disabled) return;
    panel = document.createElement('div');
    panel.className = 'picker-panel';
    panel.setAttribute('role', 'listbox');
    panel.addEventListener('mousedown', e => e.preventDefault());   // прокрутка списка не уводит фокус из поля
    document.body.appendChild(panel);
    query = '';
    active = items().findIndex(o => o.value === select.value);
    if (searchable) trigger.value = '';
    trigger.setAttribute('aria-expanded', 'true');
    renderList();
    place();
    panel.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    document.addEventListener('pointerdown', outside, true);
  }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    trigger.setAttribute('aria-expanded', 'false');
    removeEventListener('scroll', place, true);
    removeEventListener('resize', place);
    document.removeEventListener('pointerdown', outside, true);
    refresh();
  }

  function outside(e) { if (!wrap.contains(e.target) && !panel?.contains(e.target)) close(); }

  function pick(o) {
    if (!o || o.disabled) return;
    const changed = select.value !== o.value;
    select.value = o.value;
    close();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    if (searchable) trigger.blur(); else trigger.focus();
  }

  function move(step) {
    if (!shown.length) return;
    let i = active;
    for (let n = 0; n < shown.length; n++) {
      i = (i + step + shown.length) % shown.length;
      if (!shown[i].disabled) break;
    }
    active = i;
    renderList();
    panel.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  trigger.addEventListener('click', () => (panel && !searchable ? close() : open()));
  if (searchable) {
    trigger.addEventListener('focus', open);
    trigger.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== trigger) close(); }, 120));
    trigger.addEventListener('input', () => {
      if (!panel) open();
      query = trigger.value;
      active = 0;
      renderList();
      place();
    });
  }
  trigger.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!panel) open(); else move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter' && panel) {
      e.preventDefault();
      pick(shown[active] || (searchable ? shown.find(o => !o.disabled) : null));
    } else if (e.key === 'Escape' && panel) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  select.addEventListener('change', refresh);

  refresh();
  select._picker = { refresh, open, close };
  return select._picker;
}
