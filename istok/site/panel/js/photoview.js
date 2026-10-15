// ═══════════════════════════════════════════════════════════════
//  Просмотр фото на весь экран с приближением: колесо мыши (к курсору),
//  щипок двумя пальцами, двойное касание, кнопки «+» / «−». Esc — закрыть.
// ═══════════════════════════════════════════════════════════════
const MIN = 1, MAX = 6;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function openPhoto(src, alt = 'Фото') {
  const root = document.createElement('div');
  root.className = 'pv';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', alt);
  root.innerHTML = `
    <div class="pv-stage"><img class="pv-img" alt=""></div>
    <div class="pv-bar">
      <button type="button" data-z="out" aria-label="Отдалить">−</button>
      <span class="pv-pct">100%</span>
      <button type="button" data-z="in" aria-label="Приблизить">+</button>
      <button type="button" data-z="fit" aria-label="По размеру экрана">⤢</button>
      <button type="button" data-z="close" aria-label="Закрыть">✕</button>
    </div>
    <div class="pv-hint">Колесо или два пальца — приблизить · двойное касание — 2,5× · Esc — закрыть</div>`;
  const stage = root.querySelector('.pv-stage');
  const img = root.querySelector('.pv-img');
  img.src = src;
  img.alt = alt;
  const pct = root.querySelector('.pv-pct');
  let v = { s: 1, x: 0, y: 0 };
  const pts = new Map();
  let pinch = null, drag = null;

  const apply = (animate) => {
    img.style.transition = animate ? 'transform .12s ease-out' : 'none';
    img.style.transform = `translate(-50%, -50%) translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    pct.textContent = `${Math.round(v.s * 100)}%`;
  };
  /** Точка относительно центра экрана — вокруг неё и приближаем. */
  const local = (cx, cy) => {
    const r = stage.getBoundingClientRect();
    return { x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2 };
  };
  const zoomAt = (next, px, py, animate = true) => {
    const s = clamp(next, MIN, MAX);
    if (s === MIN) v = { s: MIN, x: 0, y: 0 };
    else {
      const k = s / v.s;
      v = { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    }
    apply(animate);
  };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e.clientX, e.clientY);
    zoomAt(v.s * Math.exp(-e.deltaY * 0.0015), p.x, p.y, false);
  }, { passive: false });
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const list = [...pts.values()];
    if (list.length === 2) {
      const [a, b] = list;
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: v.s, mid: local((a.x + b.x) / 2, (a.y + b.y) / 2), vx: v.x, vy: v.y };
      drag = null;
    } else if (list.length === 1) drag = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const list = [...pts.values()];
    if (list.length === 2 && pinch) {
      const [a, b] = list;
      const s = clamp(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, MIN, MAX);
      const k = s / pinch.s;
      v = s === MIN ? { s: MIN, x: 0, y: 0 } : { s, x: pinch.mid.x - (pinch.mid.x - pinch.vx) * k, y: pinch.mid.y - (pinch.mid.y - pinch.vy) * k };
      apply(false);
    } else if (list.length === 1 && drag && v.s > 1) {
      v = { ...v, x: drag.vx + e.clientX - drag.x, y: drag.vy + e.clientY - drag.y };
      apply(false);
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) drag = null;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('dblclick', (e) => {
    const p = local(e.clientX, e.clientY);
    zoomAt(v.s > 1.2 ? 1 : 2.5, p.x, p.y);
  });

  const close = () => {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = prevOverflow;
    root.remove();
    opener?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === '+' || e.key === '=') zoomAt(v.s * 1.4, 0, 0);
    if (e.key === '-') zoomAt(v.s / 1.4, 0, 0);
    if (e.key === '0') zoomAt(1, 0, 0);
  };
  root.querySelector('.pv-bar').addEventListener('click', (e) => {
    const z = e.target.closest('[data-z]')?.dataset.z;
    if (z === 'in') zoomAt(v.s * 1.4, 0, 0);
    if (z === 'out') zoomAt(v.s / 1.4, 0, 0);
    if (z === 'fit') zoomAt(1, 0, 0);
    if (z === 'close') close();
  });

  const opener = document.activeElement;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
  document.body.append(root);
  apply(false);
  root.querySelector('[data-z=close]').focus();
}
