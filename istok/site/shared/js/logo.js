// ═══════════════════════════════════════════════════════════════
//  ИСТОК — векторный знак (арка · солнце · поле)
//  Перерисован по присланному логотипу. Цвет = currentColor,
//  поэтому знак автоматически подстраивается под тему.
//  Части помечены классами для анимации появления:
//    .lg-ring  .lg-sun  .lg-field
// ═══════════════════════════════════════════════════════════════

let seq = 0;

// Геометрия в координатах исходного изображения (1250×1250)
const GAP1 = 'M262 706 Q625 574 984 668';                 // граница солнца и поля
const GAPS = [
  ['M262 706 Q625 574 984 668', 30],
  ['M262 880 Q625 704 984 698', 27],
  ['M398 1018 Q640 798 984 748', 27],
  ['M664 1016 Q800 898 984 850', 27],
];
const BODY = 'M290 640 H960 V865 Q960 1000 825 1000 H410 Q290 1000 290 880 Z';

export function logoMarkup({ className = '', title = 'ИСТОК' } = {}) {
  const id = `lg${++seq}`;
  return `
<svg class="logo-mark ${className}" viewBox="276 228 700 780" role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="${id}-top"><path d="M250 200 H1000 V668 L984 668 Q625 574 262 706 Z"/></clipPath>
    <clipPath id="${id}-bot"><path d="${GAP1} V1030 H262 Z"/></clipPath>
    <mask id="${id}-m" maskUnits="userSpaceOnUse" x="250" y="200" width="760" height="840">
      <rect x="250" y="200" width="760" height="840" fill="#fff"/>
      ${GAPS.map(([d, w]) => `<path d="${d}" fill="none" stroke="#000" stroke-width="${w}" stroke-linecap="butt"/>`).join('')}
    </mask>
  </defs>
  <g mask="url(#${id}-m)" fill="currentColor">
    <g clip-path="url(#${id}-top)">
      <circle class="lg-ring" cx="625" cy="580" r="315" fill="none" stroke="currentColor" stroke-width="54"/>
      <circle class="lg-sun" cx="625" cy="612" r="187"/>
    </g>
    <path class="lg-field" clip-path="url(#${id}-bot)" d="${BODY}"/>
  </g>
</svg>`;
}

/** Знак + надпись «ИСТОК» */
export function logoLockup({ sub = '', className = '' } = {}) {
  return `
<span class="logo ${className}">
  ${logoMarkup()}
  <span class="logo-text">
    <span class="logo-name">ИСТОК</span>
    ${sub ? `<span class="logo-sub">${sub}</span>` : ''}
  </span>
</span>`;
}

/** Вставляет знак во все элементы [data-logo] на странице */
export function mountLogos(root = document) {
  root.querySelectorAll('[data-logo]').forEach(el => {
    const kind = el.dataset.logo;
    el.innerHTML = kind === 'mark'
      ? logoMarkup({ className: el.dataset.logoClass || '' })
      : logoLockup({ sub: el.dataset.logoSub || '', className: el.dataset.logoClass || '' });
  });
}
