/*
 * Виджет стоп-листа для сайта ресторана (п. 49). Подключение — одна строка:
 *
 *   <script src="https://склад.пример/widget.js" data-location="kush" data-key="pk_…" defer></script>
 *
 * Карточки блюд на сайте помечаются атрибутом data-variant-id="…" (внешний ID блюда).
 * Кнопка заказа внутри карточки — атрибут data-add. Блок горячих предложений — элемент #stock-hot.
 * Только чтение, по публичному ключу точки, без cookie. Обновление — раз в 30 секунд.
 */
(function () {
  var script = document.currentScript;
  var loc = script.getAttribute("data-location");
  var key = script.getAttribute("data-key");
  var base = script.getAttribute("data-api") || new URL(script.src).origin;
  if (!loc || !key) return console.warn("[stock-widget] нужны data-location и data-key");

  var css = document.createElement("style");
  css.textContent =
    "[data-variant-id]{position:relative}" +
    ".sw-badge{position:absolute;top:10px;left:10px;padding:3px 9px;border-radius:999px;font:600 12px/1.4 system-ui;z-index:2}" +
    ".sw-stop{opacity:.45;filter:grayscale(.8)}" +
    ".sw-stop [data-add]{pointer-events:none;opacity:.5}" +
    ".sw-badge.stop{background:#dc2626;color:#fff}.sw-badge.low{background:#f97316;color:#fff}" +
    ".sw-badge.hot{background:#fff7ed;color:#c2410c;border:1px solid #fdba74;top:auto;bottom:10px}" +
    "#stock-hot .sw-hot-list{display:flex;gap:8px;flex-wrap:wrap}" +
    "#stock-hot .sw-hot-item{padding:8px 12px;border-radius:10px;background:#fff7ed;border:1px solid #fdba74;font:500 14px system-ui}";
  document.head.appendChild(css);

  function apply(data) {
    var byId = {};
    data.variants.forEach(function (v) { byId[v.id] = v; byId[v.dishId] = byId[v.dishId] || v; });
    var hot = {};
    data.hot.forEach(function (h) { hot[h.id] = h; });
    document.querySelectorAll("[data-variant-id]").forEach(function (el) {
      var id = el.getAttribute("data-variant-id");
      var v = byId[id];
      el.querySelectorAll(".sw-badge").forEach(function (b) { b.remove(); });
      el.classList.remove("sw-stop");
      if (!v) return;
      var badge = null;
      if (v.inStop) {
        el.classList.add("sw-stop");
        badge = mk("stop", "Нет в наличии");
      } else if (v.left) {
        badge = mk("low", "Осталось " + v.left);
      }
      if (badge) el.appendChild(badge);
      if (hot[id] && !v.inStop) el.appendChild(mk("hot", "🔥 Рекомендуем сегодня"));
    });
    var box = document.getElementById("stock-hot");
    if (box) {
      // Только DOM-методы и textContent: виджет работает на чужих сайтах, innerHTML не используем.
      box.replaceChildren();
      if (data.hot.length) {
        var list = document.createElement("div");
        list.className = "sw-hot-list";
        data.hot.forEach(function (h) {
          var item = document.createElement("span");
          item.className = "sw-hot-item";
          item.textContent = "🔥 " + h.name;
          list.appendChild(item);
        });
        box.appendChild(list);
      }
    }
    document.dispatchEvent(new CustomEvent("stock-widget:update", { detail: data }));
  }

  function mk(kind, text) {
    var b = document.createElement("span");
    b.className = "sw-badge " + kind;
    b.textContent = text;
    return b;
  }

  function load() {
    fetch(base + "/public/" + encodeURIComponent(loc) + "/menu-status?key=" + encodeURIComponent(key))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(apply)
      .catch(function (e) { console.warn("[stock-widget]", e); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
  setInterval(load, 30000);
})();
