// Встраивается в страницы склада после загрузки (MainActivity.onPageFinished).
// Файлы, которые интерфейс собирает в браузере (заказ поставщику CSV, образцы поставки), — это blob:-ссылки:
// WebView их не скачивает. Перехватываем и отдаём приложению — оно кладёт файл в «Загрузки».
(function () {
  if (window.__flagmanBridge || !window.FlagmanAndroid) return;
  window.__flagmanBridge = true;

  // Blob запоминаем при создании ссылки: интерфейс отзывает её сразу после клика
  var blobs = new Map();
  var create = URL.createObjectURL.bind(URL);
  var revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var url = create(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    revoke(url);
  };

  function save(a) {
    var blob = blobs.get(a.href);
    if (!blob) return false;
    var name = a.getAttribute("download") || "file";
    var reader = new FileReader();
    reader.onload = function () {
      var data = String(reader.result);
      window.FlagmanAndroid.saveFile(data.slice(data.indexOf(",") + 1), name, blob.type || "application/octet-stream");
    };
    reader.readAsDataURL(blob);
    return true;
  }

  // Ссылка, созданная в коде и нажатая через a.click() (в документ не попадает — событие до document не дойдёт)
  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download") && this.href.indexOf("blob:") === 0 && save(this)) return;
    return click.call(this);
  };
  // Обычная ссылка на странице
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest && e.target.closest("a[download]");
    if (a && a.href.indexOf("blob:") === 0 && save(a)) e.preventDefault();
  }, true);

  // Печать: в WebView window.print ничего не делает — честно говорим об этом
  window.print = function () { window.FlagmanAndroid.printUnavailable(); };
})();
