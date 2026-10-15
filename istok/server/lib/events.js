'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Живые обновления: GET /api/{loc}/bb/events (Server-Sent Events).
//  Гость сайта получает только изменения склада и стоп-листа; события
//  заказов (номера, статусы) — только вошедшей панели персонала.
//  События склада приходят из «Флагмана» и ретранслируются сюда.
// ═══════════════════════════════════════════════════════════════════
const flagman = require('./flagman');

const PUBLIC_TYPES = new Set(['stock.changed', 'stoplist.changed']);
const clients = new Map();   // loc → Set<{ res, staff }>

function attach(loc, req, res, staff) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 5000\n\n`);
  const client = { res, staff };
  if (!clients.has(loc)) clients.set(loc, new Set());
  clients.get(loc).add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.get(loc)?.delete(client); });
}

function emit(loc, type, data = {}) {
  const set = clients.get(loc);
  if (!set?.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of set) if (c.staff || PUBLIC_TYPES.has(type)) c.res.write(payload);
}

/**
 * Ретрансляция событий склада. onOrdersChanged(loc) — сверить статусы заказов:
 * повар мог отметить «готово» на кухне Флагмана.
 */
/**
 * Панель ИСТОК — касса, официанты, курьер: им только сигналы для всех и для кассы («закончилось — в стопе»,
 * отказ в заказе). Антифрод, запросы на одобрение и сроки партий склад адресует управляющему и складу.
 */
const forFrontOfHouse = data => !Array.isArray(data.audience) || !data.audience.length || data.audience.includes('CASHIER');

function relayFlagman(locs, { onOrdersChanged }) {
  for (const loc of locs) {
    flagman.subscribe(loc, (type, data) => {
      if (type === 'stock' || type === 'reset') {
        flagman.invalidate(loc);
        const reasons = data?.reasons || (type === 'reset' ? ['reset'] : []);
        emit(loc, 'stock.changed', { reasons, from: 'flagman' });
        if (data?.stopList || type === 'reset') emit(loc, 'stoplist.changed', { from: 'flagman' });
        if (reasons.includes('delivery.accepted')) emit(loc, 'supply.received', { from: 'flagman' });
        if (reasons.some(r => r.startsWith('writeoff') || r === 'batch.expired' || r === 'batch.disposed')) {
          emit(loc, 'writeoff.created', { from: 'flagman', reasons });
        }
        if (reasons.includes('order.status') || reasons.includes('order.canceled')) onOrdersChanged(loc);
      } else if (type === 'alert' && data?.title && forFrontOfHouse(data)) {
        emit(loc, 'alert', { title: data.title, body: data.body, severity: data.severity });
      }
    });
  }
}

module.exports = { attach, emit, relayFlagman };
