// ═══════════════════════════════════════════════════════════════
//  ИСТОК — обновления в реальном времени
//  real: Server-Sent Events  GET /api/{loc}/bb/events
//        при недоступности SSE — поллинг каждые CONFIG.POLL_INTERVAL
//  mock: события браузерного мок-сервера (BroadcastChannel)
//
//  handler({ type, loc, data }) — type:
//    order.created | order.updated | stock.changed | supply.received
//    writeoff.created | stoplist.changed | tick (поллинг)
// ═══════════════════════════════════════════════════════════════
import { CONFIG } from './config.js';
import { resolveMode } from './api.js';

export async function subscribe(loc, handler, { withCredentials = true } = {}) {
  const mode = await resolveMode();
  let stopped = false;

  if (mode === 'mock') {
    const { onMockEvent } = await import('./mock/server.js');
    const off = onMockEvent(ev => { if (!stopped && (!ev.loc || ev.loc === loc)) handler(ev); });
    // «сердцебиение»: даже без событий раз в 30 с — тик (истечение сроков и т.п.)
    const t = setInterval(() => handler({ type: 'tick', loc }), 30000);
    return () => { stopped = true; off(); clearInterval(t); };
  }

  let es = null, pollTimer = null, failures = 0;
  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => !stopped && handler({ type: 'tick', loc }), CONFIG.POLL_INTERVAL);
  };
  const connect = () => {
    if (stopped || typeof EventSource === 'undefined') { startPolling(); return; }
    try {
      es = new EventSource(`${CONFIG.API_BASE}/api/${loc}/bb/events`, { withCredentials });
    } catch { startPolling(); return; }
    es.onopen = () => { failures = 0; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
    es.onmessage = e => {
      try { const ev = JSON.parse(e.data); handler({ loc, ...ev }); } catch {}
    };
    // именованные события (event: stock.changed)
    ['order.created', 'order.updated', 'order.refused', 'stock.changed', 'supply.received', 'writeoff.created', 'stoplist.changed', 'alert'].forEach(t =>
      es.addEventListener(t, e => { let data = {}; try { data = JSON.parse(e.data); } catch {} handler({ type: t, loc, data }); }));
    es.onerror = () => {
      failures++;
      if (failures >= 3) { es.close(); es = null; startPolling(); }   // бэкенд без SSE — переходим на поллинг
    };
  };
  connect();
  return () => { stopped = true; es?.close(); if (pollTimer) clearInterval(pollTimer); };
}
