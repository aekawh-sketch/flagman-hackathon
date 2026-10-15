// Язык документации в стандартном Swagger UI. Версия выбирается в штатном списке «Select a definition»:
// «Русский» или «English». Описание API переводит сервер; здесь — только надписи самого Swagger UI,
// который не умеет менять язык: переводим их на лету по точному совпадению текста.
(function () {
  var RU_NAME = "Русский";
  var params = new URLSearchParams(location.search);
  var chosen = params.get("urls.primaryName");

  // Запоминаем выбор: при следующем заходе откроется та же версия.
  try {
    if (chosen) {
      localStorage.setItem("swaggerLang", chosen);
    } else {
      var saved = localStorage.getItem("swaggerLang");
      if (saved && saved !== RU_NAME) {
        params.set("urls.primaryName", saved);
        location.replace(location.pathname + "?" + params.toString() + location.hash);
        return;
      }
    }
  } catch (e) { /* приватный режим — просто не запомним */ }

  // Переключили версию в списке — перезагружаем страницу, чтобы и надписи Swagger сменили язык.
  document.addEventListener("change", function (e) {
    var select = e.target;
    if (!select || !select.closest || !select.closest(".topbar")) return;
    var name = select.options[select.selectedIndex] && select.options[select.selectedIndex].textContent;
    if (!name) return;
    var p = new URLSearchParams(location.search);
    p.set("urls.primaryName", name.trim());
    location.replace(location.pathname + "?" + p.toString());
  }, true);

  var russian = !chosen || chosen === RU_NAME;
  document.documentElement.lang = russian ? "ru" : "en";
  if (!russian) return;

  var RU = {
    "Try it out": "Попробовать", "Cancel": "Отмена", "Execute": "Выполнить", "Clear": "Очистить",
    "Parameters": "Параметры", "No parameters": "Без параметров", "Request body": "Тело запроса",
    "Responses": "Ответы", "Response body": "Тело ответа", "Response headers": "Заголовки ответа",
    "Server response": "Ответ сервера", "Request URL": "Адрес запроса", "Request duration": "Время запроса",
    "Code": "Код", "Description": "Описание", "Details": "Подробности", "Links": "Ссылки", "No links": "Нет ссылок",
    "Name": "Имя", "Example Value": "Пример", "Schema": "Схема", "Schemas": "Схемы", "Media type": "Тип данных",
    "Download": "Скачать", "Undocumented": "Без описания", "Servers": "Серверы", "required": "обязательно",
    "Authorize": "Войти", "Available authorizations": "Способы входа", "Close": "Закрыть", "Logout": "Выйти",
    "Value:": "Значение:", "Name:": "Имя:", "In:": "Где:", "Authorized": "Вход выполнен",
    "Send empty value": "Отправить пустое значение", "Loading...": "Загрузка…", "Examples": "Примеры",
    "Value": "Значение", "Example": "Пример", "Select a definition": "Язык документации", "Explore": "Открыть",
    "Controls": "Задаёт заголовок", "header.": "",
    "OK": "Успешно", "Created": "Создано", "Bad Request": "Неверный запрос", "Unauthorized": "Нужно войти",
    "Forbidden": "Нет прав", "Not Found": "Не найдено", "Conflict": "Конфликт", "Payload Too Large": "Файл слишком большой",
    "Internal Server Error": "Ошибка сервера", "Precondition Required": "Нужно подтверждение",
    "Unprocessable Entity": "Нельзя обработать", "Unprocessable Content": "Нельзя обработать"
  };

  // «required» у параметров Swagger рисует через CSS-псевдоэлемент — переводим стилем.
  var style = document.createElement("style");
  style.textContent = ".swagger-ui .parameter__name.required::after{content:\"обязательно\"}";
  document.head.appendChild(style);

  function translate(root) {
    if (!root || !root.ownerDocument && root !== document) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var key = node.nodeValue.trim();
      if (key && Object.prototype.hasOwnProperty.call(RU, key)) {
        node.nodeValue = node.nodeValue.replace(key, RU[key]);
      }
    }
  }

  new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType === 1) translate(n);
        else if (n.parentNode) translate(n.parentNode);
      });
      if (m.type === "characterData" && m.target.parentNode) translate(m.target.parentNode);
    });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
