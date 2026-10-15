// ═══════════════════════════════════════════════════════════════
//  Панель — общие кусочки разметки и графиков
// ═══════════════════════════════════════════════════════════════
import { esc, fmtHoursLeft, clamp, num } from '../../shared/js/utils.js';
import { CONFIG, EXPIRY } from '../../shared/js/config.js';

const ST = CONFIG.STATUS;

/** Шкала оставшегося срока годности */
export function lifeBar(hoursLeft, shelfHours) {
  const pct = shelfHours ? clamp(hoursLeft / shelfHours, 0, 1) : 0;
  const cls = hoursLeft <= 0 ? 'dead' : hoursLeft <= EXPIRY.CRITICAL_H ? 'crit' : hoursLeft <= EXPIRY.WARNING_H ? 'warn' : '';
  return `<div class="life ${cls}" title="Осталось ${fmtHoursLeft(hoursLeft)}"><div class="life-bar"><i style="width:${Math.max(3, pct * 100)}%"></i></div><span>${fmtHoursLeft(hoursLeft)}</span></div>`;
}

export function statusBadge(status) {
  const cls = {
    [ST.NEW]: 'st-new', [ST.ACCEPTED]: 'st-new', [ST.COOKING]: 'st-cook', [ST.READY]: 'st-ready',
    [ST.ON_WAY]: 'st-way', [ST.DONE]: 'st-done', [ST.CANCELLED]: 'st-cancel',
  }[status] || 'st-new';
  return `<span class="st ${cls}">${esc(status)}</span>`;
}

export function typeLabel(t) {
  return { delivery: 'Доставка', pickup: 'Самовывоз', hall: 'Зал', terrace: 'Веранда' }[t] || t || '—';
}

/** Безопасный разбор items (старый бэкенд мог отдавать JSON-строкой) */
export function parseItems(items) {
  if (Array.isArray(items)) return items;
  try { return JSON.parse(items || '[]'); } catch { return []; }
}

// ── ECharts ────────────────────────────────────────────────────
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function chartBase() {
  const text = cssVar('--text-2'), line = cssVar('--line'), muted = cssVar('--text-3');
  return {
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: text },
    grid: { left: 8, right: 12, top: 28, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis', backgroundColor: cssVar('--surface'), borderColor: cssVar('--line-2'), borderWidth: 1,
      textStyle: { color: cssVar('--text'), fontSize: 12 }, extraCssText: 'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25)',
    },
    xAxis: { axisLine: { lineStyle: { color: line } }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 11, formatter: v => typeof v === 'number' ? num(v) : v }, splitLine: { show: false } },
    yAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 11, formatter: v => typeof v === 'number' ? num(v) : v }, splitLine: { lineStyle: { color: line, type: 'dashed' } } },
    animationDuration: 900, animationEasing: 'cubicOut',
  };
}

const charts = new Map();
/** Создать/обновить график в контейнере */
export function renderChart(el, option) {
  if (!window.echarts) { el.innerHTML = '<div class="empty" style="padding:30px">Графики недоступны: библиотека не загрузилась</div>'; return null; }
  let c = charts.get(el);
  if (c && c.getDom() !== el) { c.dispose(); c = null; }
  if (!c) { c = window.echarts.init(el, null, { renderer: 'svg' }); charts.set(el, c); }
  c.setOption(option, true);
  return c;
}
addEventListener('resize', () => charts.forEach(c => c.resize()));
export const disposeCharts = () => { charts.forEach(c => c.dispose()); charts.clear(); };

export const shortDay = iso => { const [, m, d] = iso.split('-'); return `${d}.${m}`; };
export const rub = v => `${num(v)} ₽`;
