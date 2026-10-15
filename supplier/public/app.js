// Портал поставщика: собрать накладную → отправить в склад ресторана по API → увидеть, как её приняли.
const $ = (s, el = document) => el.querySelector(s);
const NB = ' ';
const UNIT = { G: { label: 'кг', k: 1000, step: '0.1' }, ML: { label: 'л', k: 1000, step: '0.1' }, PCS: { label: 'шт', k: 1, step: '1' } };
const STATUS = { PENDING: 'ждёт одобрения', APPROVED: 'одобрена — ждёт приёмки', ACCEPTED: 'принята', PARTIAL: 'принята частично',
  ACCEPTED_DIFF: 'принята с излишком', REJECTED: 'отклонена' };
const REASON = { SHORTAGE: 'недовоз', DEFECT: 'брак', EXPIRED: 'просрочено', NOT_ORDERED: 'не заказывали',
  NOT_APPROVED: 'не одобрено рестораном', OTHER: 'прочее' };

const state = { info: null, products: [], byId: {}, format: 'json', lines: [], last: null, timer: null };
const NEW = '__new';
const REST_KEY = 'fp_restaurant';

/** Латиница из названия — артикул нового продукта у ресторана: «Мука высший сорт» → fp-muka-vysshiy-sort. */
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya' };
const slug = (s) => 'fp-' + [...s.toLowerCase()].map((c) => TR[c] ?? c).join('')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Продукт строки: из каталога ресторана или новый, которого у ресторана ещё нет (ресторан проверит карточку). */
function productOf(l) {
  if (l.productId !== NEW) return state.byId[l.productId];
  const name = (l.newName || '').trim();
  return name ? { id: slug(name), name, unit: l.newUnit || 'G', isNew: true } : null;
}

// ── Время: всё по Москве, как у ресторана ─────────────────────
const MSK = 3 * 3600e3;
const toMskInput = (ms) => new Date(ms + MSK).toISOString().slice(0, 16);
const fromMskInput = (v) => new Date(Date.parse(`${v}:00Z`) - MSK);
const fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtY = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' });
/** Дата без года, если год текущий; соус на 365 дней — уже с годом, иначе «11.10» читается как сегодня. */
const dt = (d) => {
  const x = new Date(d);
  return x.getFullYear() === new Date().getFullYear() ? fmt.format(x) : fmtY.format(x);
};
const rub = (kop) => `${Math.round(kop / 100).toLocaleString('ru-RU')}${NB}₽`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const newId = () => 'FP-' + Date.now().toString(36).toUpperCase();
const newNumber = () => 'ФП-' + String(Math.floor(1000 + Math.random() * 9000));

function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast'), 3600);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Ошибка ${r.status}`);
  return data;
}

// ── Позиции ────────────────────────────────────────────────────
function blankLine(p) {
  const shelf = p?.shelfLifeHours ?? 72;
  const days = shelf >= 48 && shelf % 24 === 0;
  return { productId: p?.id ?? '', qty: '', shelf: days ? shelf / 24 : shelf, shelfUnit: days ? 'd' : 'h', price: '', priceEdited: false };
}

/** Количество в базовых единицах склада (г, мл, шт) — кратно упаковке, иначе ресторан не примет без правки. */
function baseQty(l) {
  const p = productOf(l);
  if (!p || !(Number(l.qty) > 0)) return 0;
  let q = Math.round(Number(l.qty) * UNIT[p.unit].k);
  if (p.packSize) q = Math.max(p.packSize, Math.round(q / p.packSize) * p.packSize);
  return q;
}
const shelfHours = (l) => Number(l.shelf) * (l.shelfUnit === 'd' ? 24 : 1);
const autoPrice = (l) => {
  const p = productOf(l);
  return p?.unitCostKop ? Math.round((p.unitCostKop * baseQty(l)) / 100) : '';
};

function renderLines() {
  const opts = groupedOptions();
  $('#lines').innerHTML = state.lines.map((l, i) => {
    const p = productOf(l);
    const u = UNIT[p?.unit ?? (l.productId === NEW ? l.newUnit : null)] ?? UNIT.G;
    const fresh = l.productId === NEW ? `<div class="newprod">
        <input data-k="newName" maxlength="120" value="${esc(l.newName ?? '')}" placeholder="Название продукта, например «Мука пшеничная»">
        <select data-k="newUnit"><option value="G">в кг</option><option value="ML">в л</option><option value="PCS">в шт</option></select>
      </div>` : '';
    return `<div class="line" data-i="${i}">
      <label class="f f-prod"><span>Продукт</span><select data-k="productId"><option value="">Выберите…</option><option value="${NEW}">+ Новый продукт…</option>${opts}</select></label>
      <label class="f unit f-qty"><span>Количество</span><input data-k="qty" type="number" min="0" step="${u.step}" value="${esc(l.qty)}" placeholder="0"><i>${u.label}</i></label>
      <label class="f f-shelf"><span>Срок годности</span><div class="shelf">
        <input data-k="shelf" type="number" min="1" value="${esc(l.shelf)}">
        <select data-k="shelfUnit"><option value="h">часов</option><option value="d">дней</option></select></div></label>
      <label class="f unit f-price"><span>Сумма</span><input data-k="price" type="number" min="0" value="${esc(l.price)}" placeholder="0"><i>₽</i></label>
      <button type="button" class="x" data-del aria-label="Убрать позицию">×</button>
      ${fresh}
      <div class="hint"></div>
    </div>`;
  }).join('');
  state.lines.forEach((l, i) => {
    const row = $(`.line[data-i="${i}"]`);
    $('select[data-k=productId]', row).value = l.productId;
    $('select[data-k=shelfUnit]', row).value = l.shelfUnit;
    if (l.productId === NEW) $('select[data-k=newUnit]', row).value = l.newUnit || 'G';
  });
  refresh();
}

function groupedOptions() {
  const groups = {};
  for (const p of state.products) (groups[p.category || 'Прочее'] ??= []).push(p);
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'ru'))
    .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</optgroup>`)
    .join('');
}

/** Подсказки по строкам, итог и предпросмотр запроса — после любой правки. */
function refresh() {
  const created = fromMskInput($('#created').value || toMskInput(Date.now()));
  state.lines.forEach((l, i) => {
    const row = $(`.line[data-i="${i}"]`);
    if (!row) return;
    const p = productOf(l);
    const hint = $('.hint', row);
    if (!p) { hint.textContent = l.productId === NEW ? 'Впишите название — ресторан заведёт продукт и проверит карточку при приёмке' : ''; return; }
    if (!l.priceEdited) {
      l.price = autoPrice(l);
      $('input[data-k=price]', row).value = l.price;
    }
    const exp = new Date(created.getTime() + shelfHours(l) * 3600e3);
    const expired = exp <= new Date();
    const q = baseQty(l);
    hint.innerHTML = `${q ? `${fmtQty(q, p.unit)} · ` : ''}годен до <b>${dt(exp)}</b>`
      + (expired ? ' · <span class="exp">уже просрочен — ресторан не примет</span>' : '')
      + (p.packSize ? ` · упаковка ${fmtQty(p.packSize, p.unit)}` : '')
      + (p.isNew ? ` · <span class="muted">новый для ресторана: ${esc(p.id)}</span>` : '');
  });
  const filled = state.lines.filter((l) => productOf(l) && baseQty(l) > 0);
  const sum = filled.reduce((s, l) => s + Number(l.price || 0), 0);
  $('#total').innerHTML = filled.length
    ? `Позиций: <b>${filled.length}</b> · сумма <b>${sum.toLocaleString('ru-RU')}${NB}₽</b>` : '';
  renderPreview();
}

function fmtQty(q, unit) {
  if (unit === 'PCS') return `${q}${NB}шт`;
  const [small, big] = unit === 'ML' ? ['мл', 'л'] : ['г', 'кг'];
  return q < 1000 ? `${q}${NB}${small}` : `${String(+(q / 1000).toFixed(2)).replace('.', ',')}${NB}${big}`;
}

function buildDelivery() {
  return {
    id: state.draftId,
    number: $('#number').value.trim(),
    createdAt: fromMskInput($('#created').value).toISOString().replace(/\.\d+Z$/, 'Z'),
    supplier: state.info?.supplier,
    lines: state.lines.filter((l) => productOf(l) && baseQty(l) > 0).map((l) => {
      const p = productOf(l);
      return { productId: p.id, name: p.name, unit: p.unit, qty: baseQty(l), shelfLifeHours: shelfHours(l),
        costKop: l.price ? Math.round(Number(l.price) * 100) : undefined };
    }),
  };
}

/** То же, что соберёт сервер портала: JSON или XML в формате склада. */
function payloadOf(d, format) {
  if (format === 'json') return JSON.stringify(d, null, 2);
  const a = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<delivery ${a({ id: d.id, number: d.number, createdAt: d.createdAt, supplier: d.supplier })}>\n`
    + d.lines.map((l) => `  <line ${a(l)}/>`).join('\n') + '\n</delivery>';
}

/** Черновик следующей накладной. Отправленный запрос с ответом склада висит, пока форму не начали править. */
function renderPreview() {
  if (state.sentView) {
    state.sentView = false;
    $('#resp').hidden = true;
  }
  const loc = $('#loc').value;
  const d = buildDelivery();
  $('#reqMeta').textContent = `POST /api/${loc || '{точка}'}/deliveries · ${state.format === 'xml' ? 'application/xml' : 'application/json'}`;
  $('#reqBody').textContent = d.lines.length ? payloadOf(d, state.format) : 'Добавьте позиции — здесь появится документ, который уйдёт в API';
}

// ── Отправка ───────────────────────────────────────────────────
async function sendDelivery(job) {
  const btn = $('#sendBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job) });
    showResponse(r);
    if (r.status === 201 || r.status === 200) {
      state.last = job;
      $('#resendBtn').hidden = false;
      if (r.status === 201) {
        toast(`Накладная ${job.delivery.number} ушла на склад — ждёт приёмки`);
        state.draftId = newId();            // следующая отправка формы — уже новая поставка
        $('#number').value = newNumber();
      } else {
        toast('Склад узнал повтор и не задвоил поставку');
      }
      loadHistory();
    } else {
      toast(r.response?.error || `Склад ответил ${r.status}`, true);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function showResponse(r) {
  $('#reqMeta').textContent = `${r.request.method} ${r.request.url} · X-Api-Key: ${r.request.apiKey}`;
  $('#reqBody').textContent = r.request.body;
  const code = $('#respCode');
  code.textContent = r.status;
  code.className = `code-badge ${r.status === 201 ? 'ok' : r.status === 200 ? 'info' : 'bad'}`;
  $('#respText').textContent = r.status === 201 ? 'Создана — ждёт приёмки в ресторане'
    : r.status === 200 ? 'Повтор того же документа — склад вернул уже созданную поставку'
    : r.status === 409 ? 'Тот же ID с другим содержимым — склад отказал'
    : r.status === 403 ? 'Нет права у ключа' : 'Склад отклонил документ';
  $('#respBody').textContent = JSON.stringify(r.response, null, 2);
  $('#resp').hidden = false;
  state.sentView = true;
}

// ── История: что ресторан сделал с отгрузкой ──────────────────
async function loadHistory() {
  const loc = $('#loc').value;
  if (!loc) return;
  try {
    const list = await api(`/api/deliveries?location=${encodeURIComponent(loc)}`);
    $('#history').innerHTML = list.length ? list.map(renderDelivery).join('')
      : '<p class="muted">Пока ни одной отгрузки в эту точку</p>';
  } catch (e) {
    $('#history').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

function renderDelivery(d) {
  const lines = d.lines.map((l) => {
    const got = l.qtyActual;
    let tail = '';
    if (d.status === 'APPROVED' && l.approvedQty != null && l.approvedQty < l.qtyInvoice) {
      // Ресторан уже решил, что берёт, — поставщик видит это до приёмки.
      tail = l.approvedQty === 0 ? '<span class="no">не берут</span>' : `<span class="why">берут ${esc(l.approvedQtyText)}</span>`;
      if (l.approveNote) tail += ` <span class="muted">(${esc(l.approveNote)})</span>`;
    } else if (!['PENDING', 'APPROVED', 'REJECTED'].includes(d.status) && got != null && got < l.qtyInvoice) {
      tail = got === 0 ? `<span class="no">не принято — ${REASON[l.rejectReason] ?? 'отказ'}</span>`
        : `<span class="why">принято ${esc(l.qtyActualText)} — ${REASON[l.rejectReason] ?? 'недовоз'}</span>`;
      const why = l.rejectComment || l.approveNote;
      if (why) tail += ` <span class="muted">(${esc(why)})</span>`;
    }
    return `<li><span>${esc(l.name)} · ${esc(l.qtyText)}</span>${tail}</li>`;
  }).join('');
  const who = d.acceptedBy ? ` · ${d.status === 'REJECTED' ? 'отклонил' : 'принял'} ${esc(d.acceptedBy)} ${d.acceptedAt ? dt(d.acceptedAt) : ''}`
    : d.approvedBy ? ` · одобрил ${esc(d.approvedBy)}` : '';
  return `<article class="dl">
    <div class="dl-h"><b>${esc(d.number)}</b><span class="badge ${esc(d.status)}">${esc(STATUS[d.status] ?? d.status)}</span>
      <span class="muted">отгружено ${dt(d.createdAt)}${who}</span></div>
    <ul>${lines}</ul>
    ${d.rejectComment ? `<div class="note">Причина отказа: ${esc(d.rejectComment)}</div>` : ''}
  </article>`;
}

// ── Старт ──────────────────────────────────────────────────────
async function init() {
  $('#created').value = toMskInput(Date.now());
  $('#number').value = newNumber();
  state.draftId = newId();
  const conn = $('#conn');
  try {
    state.info = await api('/api/info');
  } catch (e) {
    conn.className = 'conn bad';
    conn.lastElementChild.textContent = e.message;
    return;
  }
  renderRestaurants();
  await chooseRestaurant(localStorage.getItem(REST_KEY));
  state.timer = setInterval(() => !document.hidden && loadHistory(), 5000);
  // Новые предприятия появляются сами: список ресторанов освежаем раз в минуту
  setInterval(async () => {
    if (document.hidden) return;
    try { state.info = await api('/api/info'); renderRestaurants(); } catch { /* склад недоступен — список прежний */ }
  }, 60_000);
}

/**
 * «Новое» — ресторан, которого этот поставщик ещё не видел: подключился к платформе после прошлого визита.
 * Видел — запоминаем в браузере; при самом первом входе новых нет, пометка снимается, когда ресторан выбрали.
 */
const SEEN_KEY = 'fp_seen_restaurants';
function seenSet() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) {
      const all = state.info.restaurants.map((r) => String(r.id));
      localStorage.setItem(SEEN_KEY, JSON.stringify(all));
      return new Set(all);
    }
    return new Set(JSON.parse(raw));
  } catch { return new Set(state.info.restaurants.map((r) => String(r.id))); }
}
function markSeen(id) {
  try {
    const s = seenSet();
    s.add(String(id));
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
  } catch { /* приватный режим — пометка просто не запомнится */ }
}

/** Список ресторанов: новые сверху и с пометкой; в шапке — сколько всего и сколько новых. */
function renderRestaurants() {
  const seen = seenSet();
  const list = state.info.restaurants.map((r) => ({ ...r, isNew: !seen.has(String(r.id)) }));
  const fresh = list.filter((r) => r.isNew).length;
  const conn = $('#conn');
  conn.className = 'conn ok';
  conn.lastElementChild.textContent = `Ресторанов: ${list.length}${fresh ? ` · новых: ${fresh}` : ''} · ключ ${state.info.keyPrefix}…`;
  const cur = $('#rest').value;
  $('#rest').innerHTML = list.map((r) => `<option value="${r.id}">${esc(r.name)}${r.isNew ? ' · новое' : ''} — ${r.locations.length} ${r.locations.length === 1 ? 'точка' : r.locations.length < 5 ? 'точки' : 'точек'}</option>`).join('');
  if (cur && list.some((r) => String(r.id) === cur)) $('#rest').value = cur;
}

/** Выбрали ресторан: его точки, его каталог, позиции — заново (у другого ресторана другие продукты). */
async function chooseRestaurant(id) {
  const list = state.info.restaurants;
  if (!list.length) {
    $('#loc').innerHTML = '';
    toast('Ни одного ресторана на платформе — склад ещё пуст', true);
    return;
  }
  const r = list.find((x) => String(x.id) === String(id)) ?? list[0];
  $('#rest').value = String(r.id);
  localStorage.setItem(REST_KEY, String(r.id));
  if (!seenSet().has(String(r.id))) {
    markSeen(r.id);
    renderRestaurants();
    $('#rest').value = String(r.id);
  }
  $('#loc').innerHTML = r.locations.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  try {
    state.products = await api(`/api/catalog?location=${encodeURIComponent(r.locations[0].id)}`);
  } catch (e) {
    state.products = [];
    toast('Каталог ресторана не загрузился: ' + e.message, true);
  }
  state.byId = Object.fromEntries(state.products.map((p) => [p.id, p]));
  $('#emptyCat').hidden = state.products.length > 0;
  state.lines = [state.products.length ? blankLine() : { ...blankLine(), productId: NEW, newName: '', newUnit: 'G' }];
  renderLines();
  loadHistory();
}

// ── События ────────────────────────────────────────────────────
$('#lines').addEventListener('input', (e) => {
  const row = e.target.closest('.line');
  const k = e.target.dataset.k;
  if (!row || !k) return;
  const l = state.lines[Number(row.dataset.i)];
  if (k === 'productId') {
    Object.assign(l, blankLine(state.byId[e.target.value]), { qty: l.qty },
      e.target.value === NEW ? { productId: NEW, newName: '', newUnit: 'G' } : {});
    renderLines();
    if (e.target.value === NEW) $(`.line[data-i="${row.dataset.i}"] input[data-k=newName]`)?.focus();
    return;
  }
  if (k === 'newUnit') {
    l.newUnit = e.target.value;
    renderLines();
    return;
  }
  l[k] = e.target.value;
  if (k === 'price') l.priceEdited = e.target.value !== '';
  refresh();
});
$('#lines').addEventListener('click', (e) => {
  if (!e.target.closest('[data-del]')) return;
  const i = Number(e.target.closest('.line').dataset.i);
  state.lines.splice(i, 1);
  if (!state.lines.length) state.lines.push(blankLine());
  renderLines();
});
$('#addLine').onclick = () => {
  state.lines.push(state.products.length ? blankLine() : { ...blankLine(), productId: NEW, newName: '', newUnit: 'G' });
  renderLines();
};
$('#typical').onclick = () => {
  if (!state.products.length) return toast('У этого ресторана каталог пока пуст — добавьте «+ Новый продукт»', true);
  const pool = state.products.filter((p) => p.shelfLifeHours).sort(() => Math.random() - 0.5).slice(0, 4);
  state.lines = pool.map((p) => ({ ...blankLine(p),
    qty: p.unit === 'PCS' ? 10 + Math.floor(Math.random() * 30) : (2 + Math.floor(Math.random() * 4)) }));
  renderLines();
};
$('#backdate').onclick = (e) => {
  const b = e.target.closest('[data-days]');
  if (!b) return;
  $('#created').value = toMskInput(Date.now() - Number(b.dataset.days) * 86400e3);
  refresh();
};
$('#created').oninput = refresh;
$('#number').oninput = renderPreview;
$('#loc').onchange = () => { renderPreview(); loadHistory(); };
$('#rest').onchange = (e) => chooseRestaurant(e.target.value);
document.querySelectorAll('[data-format]').forEach((b) => b.onclick = () => {
  state.format = b.dataset.format;
  document.querySelectorAll('[data-format]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderPreview();
});
$('#form').onsubmit = (e) => {
  e.preventDefault();
  const d = buildDelivery();
  if (!d.lines.length) return toast('Добавьте хотя бы одну позицию', true);
  sendDelivery({ location: $('#loc').value, format: state.format, delivery: d });
};
$('#resendBtn').onclick = () => state.last && sendDelivery(state.last);

init();
