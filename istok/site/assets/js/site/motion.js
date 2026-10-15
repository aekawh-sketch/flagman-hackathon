// ═══════════════════════════════════════════════════════════════
//  Сайт — движение: Lenis (плавный скролл) + GSAP/ScrollTrigger
//  Всё деградирует мягко: нет GSAP или включено «уменьшение
//  движения» — контент просто показывается без анимаций.
// ═══════════════════════════════════════════════════════════════
import { $, $$, prefersReducedMotion } from '../../../shared/js/utils.js';

const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
export const enabled = !!(gsap && ScrollTrigger) && !prefersReducedMotion();
let lenis = null;
const root = document.documentElement;

if (enabled) {
  gsap.registerPlugin(ScrollTrigger);
  root.classList.add('motion');
} else {
  root.classList.add(gsap ? 'no-motion' : 'no-gsap');
}

// ── Плавный скролл ─────────────────────────────────────────────
export function initSmoothScroll() {
  if (!enabled || !window.Lenis || matchMedia('(hover: none)').matches) return;
  lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true, wheelMultiplier: 1, gestureOrientation: 'vertical' });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(t => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}

export function scrollToTarget(target, offset = -80) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  if (lenis) lenis.scrollTo(el, { offset, duration: 1.4, easing: t => 1 - Math.pow(1 - t, 4) });
  else window.scrollTo({ top: el.getBoundingClientRect().top + scrollY + offset, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

let locks = 0;
export function lockScroll(on) {
  locks = Math.max(0, locks + (on ? 1 : -1));
  const locked = locks > 0;
  if (lenis) locked ? lenis.stop() : lenis.start();
  document.body.classList.toggle('no-scroll', locked);
}

export const refresh = () => enabled && ScrollTrigger.refresh();

// ── Прелоадер ──────────────────────────────────────────────────
export function preloader() {
  const el = $('#preloader');
  if (!el) return Promise.resolve();
  if (!enabled) { el.remove(); return Promise.resolve(); }
  // полная заставка — только при первом заходе за сессию
  try { if (sessionStorage.getItem('istok_pre')) { el.remove(); return Promise.resolve(); } sessionStorage.setItem('istok_pre', '1'); } catch {}
  return new Promise(resolve => {
    const ring = el.querySelector('.lg-ring');
    const sun = el.querySelector('.lg-sun');
    const field = el.querySelector('.lg-field');
    const count = $('#preCount');
    const len = 2 * Math.PI * 315;
    gsap.set(ring, { strokeDasharray: len, strokeDashoffset: len });
    gsap.set(sun, { y: 260 });
    gsap.set(field, { y: 120, opacity: 0 });
    gsap.set('.preloader-word span', { yPercent: 110 });
    gsap.set('.preloader-sub', { opacity: 0, y: 8 });
    const counter = { v: 0 };
    const fontsReady = document.fonts?.ready || Promise.resolve();
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } });
    tl.to(ring, { strokeDashoffset: 0, duration: 1.1, ease: 'power2.inOut' })
      .to(sun, { y: 0, duration: 0.9 }, 0.35)
      .to(field, { y: 0, opacity: 1, duration: 0.8 }, 0.5)
      .to('.preloader-word span', { yPercent: 0, stagger: 0.06, duration: 0.8 }, 0.55)
      .to('.preloader-sub', { opacity: 1, y: 0, duration: 0.6 }, 0.9)
      .to(counter, { v: 100, duration: 1.5, ease: 'power2.inOut', onUpdate: () => { count.textContent = Math.round(counter.v); } }, 0)
      .to('#preBar', { scaleX: 1, duration: 1.5, ease: 'power2.inOut' }, 0);
    fontsReady.then(() => tl.play());
    tl.eventCallback('onComplete', () => {
      if (!document.body.contains(el)) return;      // страховочный таймер уже убрал прелоадер
      gsap.timeline({ onComplete: () => { el.remove(); } })
        .to('.preloader-inner', { y: -40, opacity: 0, duration: 0.5, ease: 'power2.in' })
        .to(el, { clipPath: 'inset(0 0 100% 0)', duration: 0.9, ease: 'expo.inOut' }, 0.25)
        .add(resolve, 0.55);
    });
    // страховка: если что-то пошло не так — убрать через 5 с
    setTimeout(() => { if (document.body.contains(el)) { el.remove(); resolve(); } }, 5000);
  });
}

// ── Hero ───────────────────────────────────────────────────────
export function heroIntro() {
  if (!enabled) return;
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.from('.hero-title .ch', { yPercent: 120, rotate: 12, opacity: 0, stagger: 0.07, duration: 1.4 })
    .from('.hero .reveal', { y: 30, opacity: 0, stagger: 0.08, duration: 1.1 }, 0.25)
    .from('.hero-float', { scale: 0.4, opacity: 0, stagger: 0.1, duration: 1.6, ease: 'elastic.out(1, 0.75)' }, 0.15)
    .from('.hero-sun', { scale: 0.6, opacity: 0, duration: 1.8 }, 0)
    .from('.header-inner > *', { y: -24, opacity: 0, stagger: 0.05, duration: 0.9, clearProps: 'transform,opacity' }, 0.3);

  // Параллакс по скроллу
  $$('.hero-float').forEach(f => {
    const d = parseFloat(f.dataset.depth || 0.5);
    gsap.to(f, { yPercent: -60 * d, rotate: `+=${d * 10}`, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  });
  gsap.to('.hero-title', { scale: 0.86, opacity: 0.15, yPercent: 18, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  gsap.to('.hero-sun', { scale: 1.4, rotate: 40, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

  // Параллакс по мыши
  if (matchMedia('(hover: hover)').matches) {
    const floats = $$('.hero-float').map(f => ({
      d: parseFloat(f.dataset.depth || 0.5),
      x: gsap.quickTo(f, 'x', { duration: 1.2, ease: 'power3' }),
      y: gsap.quickTo(f, 'y', { duration: 1.2, ease: 'power3' }),
    }));
    const chars = $$('.hero-title .ch');
    $('.hero').addEventListener('pointermove', e => {
      const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5;
      floats.forEach(f => { f.x(nx * 60 * f.d); f.y(ny * 40 * f.d); });
      chars.forEach((c, i) => gsap.to(c, { x: nx * (i - 2) * 6, y: ny * 8, duration: 1, ease: 'power3', overwrite: 'auto' }));
    });
  }
}

// ── Бегущая строка, зависящая от скорости скролла ─────────────
export function marquee() {
  if (!enabled) return;
  const track = $('#marquee');
  track.style.animation = 'none';
  const tween = gsap.to(track, { xPercent: -50, repeat: -1, duration: 30, ease: 'none' });
  let dir = 1;
  ScrollTrigger.create({
    onUpdate: self => {
      dir = self.direction;
      const v = Math.min(6, Math.abs(self.getVelocity()) / 400);
      gsap.to(tween, { timeScale: dir * (1 + v), duration: 0.3, overwrite: true, onComplete: () => gsap.to(tween, { timeScale: dir, duration: 1.2 }) });
    },
  });
}

// ── Появления по скроллу ───────────────────────────────────────
export function scrollReveals() {
  if (!enabled) return;
  $$('.section-title .split-line > span').forEach(s => {
    gsap.from(s, { yPercent: 110, rotate: 4, duration: 1.2, ease: 'expo.out', scrollTrigger: { trigger: s, start: 'top 90%' } });
  });
  $$('.section-eyebrow, .section-lead').forEach(el => {
    if (el.closest('.hero')) return;
    gsap.from(el, { y: 20, opacity: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 92%' } });
  });
  $$('.reveal').forEach(el => {
    if (el.closest('.hero')) return;
    gsap.from(el, { y: 40, opacity: 0, duration: 1.1, ease: 'expo.out', scrollTrigger: { trigger: el, start: 'top 90%' } });
  });

  // Фоновый узор едва заметно смещается при прокрутке — ощущение глубины
  gsap.to('#bgPattern', { yPercent: -4, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: true } });

  // История: слова «загораются» по мере скролла
  const story = $('#storyText');
  if (story) {
    splitWords(story);
    gsap.to(story.querySelectorAll('.w'), {
      opacity: 1, stagger: 0.1, ease: 'none',
      scrollTrigger: { trigger: story, start: 'top 80%', end: 'bottom 45%', scrub: true },
    });
  }

  // Счётчики
  $$('[data-count]').forEach(el => {
    const to = Number(el.dataset.count);
    ScrollTrigger.create({
      trigger: el, start: 'top 90%', once: true,
      onEnter: () => { const o = { v: 0 }; gsap.to(o, { v: to, duration: 1.6, ease: 'power3.out', onUpdate: () => { el.textContent = Math.round(o.v); } }); },
    });
  });

}

function splitWords(el) {
  const walk = node => {
    [...node.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(part => {
          if (!part) return;
          if (/^\s+$/.test(part)) frag.appendChild(document.createTextNode(part));
          else { const s = document.createElement('span'); s.className = 'w'; s.textContent = part; frag.appendChild(s); }
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1) walk(n);
    });
  };
  walk(el);
}

/** Появление новых карточек (меню перерисовывается динамически) */
export function revealCards(container) {
  if (!enabled) return;
  // триггеры от карточек, которых уже нет в DOM (после перерисовки), — удаляем
  ScrollTrigger.getAll().forEach(t => { if (t.trigger && !document.contains(t.trigger)) t.kill(); });
  const cards = $$('.card:not([data-rev]), .hot-card:not([data-rev])', container);
  if (!cards.length) return;
  cards.forEach(c => { c.dataset.rev = '1'; gsap.set(c, { opacity: 0, y: 40 }); });
  ScrollTrigger.batch(cards, {
    start: 'top 95%', once: true,
    onEnter: batch => gsap.to(batch, { opacity: 1, y: 0, stagger: 0.06, duration: 0.9, ease: 'expo.out', overwrite: true }),
  });
  // карточки, уже находящиеся в зоне видимости
  requestAnimationFrame(() => ScrollTrigger.refresh());
}

// ── Шапка: прячется при скролле вниз ───────────────────────────
export function headerBehavior() {
  const header = $('#header');
  let last = scrollY;
  const onScroll = () => {
    const y = scrollY;
    header.classList.toggle('is-scrolled', y > 30);
    const down = y > last && y > 400;
    header.classList.toggle('is-hidden', down);
    document.body.classList.toggle('header-visible', !down);
    last = y;
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ── Магнитные кнопки ───────────────────────────────────────────
export function magnetic(root = document) {
  if (!enabled || !matchMedia('(hover: hover)').matches) return;
  $$('[data-magnetic]', root).forEach(el => {
    if (el._mag) return;
    el.style.willChange = 'transform';
    el._mag = true;
    const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'elastic.out(1, 0.4)' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'elastic.out(1, 0.4)' });
    el.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - r.left - r.width / 2) * 0.3);
      yTo((e.clientY - r.top - r.height / 2) * 0.35);
    });
    el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
  });
}

// ── 3D-наклон карточек ─────────────────────────────────────────
export function tilt(container, selector = '.card, .hot-card') {
  if (!enabled || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  container.addEventListener('pointermove', e => {
    const card = e.target.closest(selector);
    if (!card || card.classList.contains('is-stop')) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
    gsap.to(card, { rotateY: px * 7, rotateX: -py * 7, transformPerspective: 900, duration: 0.5, ease: 'power3.out', overwrite: 'auto' });
  });
  container.addEventListener('pointerout', e => {
    const card = e.target.closest(selector);
    if (card && !card.contains(e.relatedTarget)) gsap.to(card, { rotateY: 0, rotateX: 0, duration: 0.8, ease: 'elastic.out(1, 0.5)' });
  });
}

// ── Полёт в корзину ────────────────────────────────────────────
export function flyToCart(imgSrc, fromEl) {
  const fab = $('#cartFab');
  const target = fab && getComputedStyle(fab).display !== 'none' && fab.classList.contains('show') ? fab : $('#cartBtn');
  const bump = () => { target.classList.remove('bump'); void target.offsetWidth; target.classList.add('bump'); };
  if (!enabled || !fromEl || !imgSrc) { bump(); return; }
  const a = fromEl.getBoundingClientRect(), b = target.getBoundingClientRect();
  const fly = document.createElement('div');
  fly.className = 'fly';
  fly.innerHTML = `<img src="${imgSrc}" alt="">`;
  document.body.appendChild(fly);
  const sx = a.left + a.width / 2 - 32, sy = a.top + a.height / 2 - 32;
  const ex = b.left + b.width / 2 - 32, ey = b.top + b.height / 2 - 32;
  gsap.set(fly, { x: sx, y: sy, scale: 0.4, opacity: 0 });
  gsap.timeline({ onComplete: () => { fly.remove(); bump(); } })
    .to(fly, { scale: 1.15, opacity: 1, duration: 0.25, ease: 'back.out(3)' })
    .to(fly, { x: ex, duration: 0.75, ease: 'power2.inOut' }, 0.2)
    .to(fly, { y: Math.min(sy, ey) - 120, duration: 0.35, ease: 'power2.out' }, 0.2)
    .to(fly, { y: ey, duration: 0.4, ease: 'power2.in' }, 0.55)
    .to(fly, { scale: 0.3, opacity: 0.2, duration: 0.3, ease: 'power2.in' }, 0.7);
}
