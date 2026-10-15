// «Флагман» для Windows — два режима (меню «Флагман», выбор хранится в settings.json):
//  • «сервер» (по умолчанию) — склад в интернете в окне программы: те же данные, что в телефоне и на сайте;
//  • «этот компьютер» — своя база PostgreSQL и сервер склада на Java внутри программы. Первый запуск создаёт базу
//    и заливает присланный дамп (resources/seed); данные — в %ProgramData%\Flagman. Закрыли окно — всё остановилось.
"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const WIN = process.platform === "win32";
const PG_PORT = 54329;            // не 5432: у человека может стоять свой PostgreSQL
const APP_PORT = 8080;            // занят — возьмём любой свободный
const DB = "flagman";
const DB_USER = "flagman";

// Всё, что внутри программы: в собранной — resources/, в разработке — desktop/stage/ (собирает build.mjs)
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, "stage");
// Проверка на маке: свои PostgreSQL и Java вместо windows-версий
const PG_BIN = process.env.FLAGMAN_PG_BIN || path.join(RES, "runtime", "pgsql", "bin");
const JAVA = process.env.FLAGMAN_JAVA || path.join(RES, "runtime", "jre", "bin", WIN ? "java.exe" : "java");
// Проверка сборки без окон: поднять всё, убедиться, что склад отдал страницу и API, штатно выйти
const SMOKE = process.env.FLAGMAN_SMOKE === "1";
const ICON = path.join(__dirname, "assets", "icon.png");
// Интерфейсу нужно ровно это: скопировать ссылку-приглашение и экран кухни во весь экран. Камеры, микрофона,
// чтения буфера обмена и геолокации у программы нет.
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

// Склад в интернете по умолчанию — тот же, что у Android-приложения; сменить — «Флагман → Адрес сервера…»
const DEFAULT_SERVER = "http://31.76.28.248:8085";

let DATA, PGDATA, LOGS, UPLOADS, SECRET, READY, KEYS, URL_FILE;
let splash = null;
let win = null;
let server = null;
let stopping = null;
let mode = "server";
let origin = null;          // склад в окне: http://127.0.0.1:порт или сервер в интернете
let connectError = null;    // что показать на странице подключения

const bin = (name) => path.join(PG_BIN, WIN ? `${name}.exe` : name);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Режим и адрес сервера ───────────────────────────────────────────────────

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  const defaults = { mode: "server", serverUrl: DEFAULT_SERVER };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    return defaults;
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

const normalizeUrl = (raw) => {
  const url = String(raw).trim().replace(/\/+$/, "");
  return !url || /^https?:\/\//i.test(url) ? url : `http://${url}`;
};

/** GET по http или https — ответ целиком; для проверки склада и адреса кассы. */
function fetchText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("нет ответа")));
    req.on("error", reject);
  });
}

const serverHealthy = (url) => fetchText(`${url}/actuator/health`).then((r) => r.status === 200 && r.body.includes("UP"), () => false);

/** Тот же склад: схема, хост и порт; localhost и 127.0.0.1 — одно и то же. */
function sameSite(url, base) {
  try {
    const u = new URL(url);
    const b = new URL(base);
    const host = (h) => (h === "localhost" ? "127.0.0.1" : h);
    return u.protocol === b.protocol && u.port === b.port && host(u.hostname) === host(b.hostname);
  } catch {
    return false;
  }
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  if (SMOKE) process.stdout.write(text);
  if (LOGS) fs.appendFileSync(path.join(LOGS, "launcher.log"), text);
}

function tail(file, chars = 1500) {
  try {
    return fs.readFileSync(file, "utf8").slice(-chars).trim();
  } catch {
    return "";
  }
}

/**
 * Данные — в %ProgramData%\Flagman: в пути нет имени пользователя (PostgreSQL на Windows спотыкается о кириллицу,
 * если она не в кодировке системы), и ту же папку находят ручные команды из manual\. Нет прав — в профиль.
 */
function initPaths() {
  const candidates = process.env.FLAGMAN_DATA ? [process.env.FLAGMAN_DATA]
    : [...(WIN ? [path.join(process.env.ProgramData || "C:\\ProgramData", "Flagman")] : []), path.join(app.getPath("userData"), "data")];
  DATA = candidates.find((dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, ".write-test");
      fs.writeFileSync(probe, "");
      fs.rmSync(probe);
      return true;
    } catch {
      return false;
    }
  });
  if (!DATA) throw new Error(`Негде хранить базу: нет прав на запись в ${candidates.join(" и ")}`);
  PGDATA = path.join(DATA, "pgdata");
  LOGS = path.join(DATA, "logs");
  UPLOADS = path.join(DATA, "uploads");
  SECRET = path.join(DATA, "db-password.txt");
  READY = path.join(DATA, "restored.ok");
  KEYS = path.join(DATA, "keys.env");
  URL_FILE = path.join(DATA, "flagman-url.txt");
  fs.mkdirSync(LOGS, { recursive: true });
}

/**
 * Ключи, которыми сайт ИСТОК и портал поставщика (manual\start-site.bat, start-supplier.bat) ходят в склад, и служебный
 * пароль панели. Свои на каждом компьютере: создаются один раз, склад заводит их у себя при запуске (SeedService).
 */
function ensureKeys() {
  const keys = {};
  if (fs.existsSync(KEYS)) {
    for (const line of fs.readFileSync(KEYS, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) keys[m[1]] = m[2].trim();
    }
  }
  const token = () => crypto.randomBytes(16).toString("hex");
  const want = { SITE_API_KEY: () => `sk_istok_${token()}`, SUPPLIER_API_KEY: () => `sk_supplier_${token()}`, ADMIN_TOKEN: token };
  const missing = Object.keys(want).filter((k) => !keys[k]);
  if (missing.length) {
    for (const k of missing) keys[k] = want[k]();
    fs.writeFileSync(KEYS, Object.entries(keys).map(([k, v]) => `${k}=${v}`).join("\r\n") + "\r\n");
  }
  return keys;
}

function checkBundle() {
  const need = [bin("initdb"), bin("pg_ctl"), bin("pg_restore"), JAVA, path.join(RES, "server", "stock.jar"),
    path.join(RES, "web", "index.html")];
  const missing = need.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`Программа распакована не полностью — нет файлов:\n${missing.join("\n")}\n\nРаспакуйте архив заново целиком.`);
}

function status(text) {
  log(text);
  splash?.webContents.executeJavaScript(`setStatus(${JSON.stringify(text)})`).catch(() => {});
}

/** Запустить консольную программу без окна и дождаться выхода; вывод — в журнал запуска. */
function run(cmd, args, { env = {}, capture = true } = {}) {
  return new Promise((resolve, reject) => {
    // pg_ctl start оставляет работать postgres: его вывод — в свой журнал, иначе он унаследует наши каналы
    const child = spawn(cmd, args, {
      env: { ...process.env, LC_MESSAGES: "C", LANG: "C", ...env },
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      const name = path.basename(cmd);
      log(`${name} ${args.join(" ")} → ${code}${out.trim() ? `\n${out.trim()}` : ""}`);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(`${name}: код ${code}${out.trim() ? `\n${out.trim().slice(-1500)}` : ""}`), { code }));
    });
  });
}

const pgEnv = () => ({
  PGHOST: "127.0.0.1", PGPORT: String(PG_PORT), PGUSER: DB_USER, PGPASSWORD: fs.readFileSync(SECRET, "utf8").trim(),
});

/** Своя база на этом компьютере: создаётся один раз, слушает только 127.0.0.1, пароль — случайный. */
async function ensureCluster() {
  if (fs.existsSync(path.join(PGDATA, "PG_VERSION")) && fs.existsSync(SECRET)) return;
  status("Первый запуск: создаём базу данных…");
  fs.rmSync(PGDATA, { recursive: true, force: true });            // остатки прерванной попытки
  const password = crypto.randomBytes(16).toString("hex");
  const pwfile = path.join(DATA, "initdb-pw.tmp");
  fs.writeFileSync(pwfile, password);
  try {
    await run(bin("initdb"), ["-D", PGDATA, "-U", DB_USER, "-E", "UTF8", "--locale=C", "--auth=scram-sha-256", `--pwfile=${pwfile}`]);
  } finally {
    fs.rmSync(pwfile, { force: true });
  }
  fs.appendFileSync(path.join(PGDATA, "postgresql.conf"), `\n# Flagman: only this computer, own port\nlisten_addresses = '127.0.0.1'\nport = ${PG_PORT}\n`);
  fs.writeFileSync(SECRET, password);
  fs.rmSync(READY, { force: true });
}

async function startPg() {
  try {
    await run(bin("pg_ctl"), ["status", "-D", PGDATA]);
    log("PostgreSQL уже работает — после прошлого запуска");
    return;
  } catch {
    // не запущен — запускаем
  }
  status("Запускаем базу данных…");
  const pgLog = path.join(LOGS, "postgres.log");
  try {
    await run(bin("pg_ctl"), ["start", "-w", "-t", "120", "-D", PGDATA, "-l", pgLog], { capture: false });
  } catch (e) {
    throw new Error(`База данных не запустилась.\n\n${tail(pgLog) || e.message}`);
  }
}

/** Заливка присланной базы: один раз после создания и после «Вернуть базу к исходной». */
async function ensureData() {
  if (fs.existsSync(READY)) return;
  status("Первый запуск: загружаем данные склада…");
  const env = pgEnv();
  await run(bin("dropdb"), ["--if-exists", DB], { env });
  await run(bin("createdb"), [DB], { env });
  const dump = path.join(RES, "seed", "flagman.dump");
  if (fs.existsSync(dump)) {
    await run(bin("pg_restore"), ["--no-owner", "--no-privileges", "--exit-on-error", "-d", DB, dump], { env });
  } else {
    log("Дампа нет — сервер сам зальёт демо-данные в пустую базу");
  }
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  const photos = path.join(RES, "seed", "uploads");
  if (fs.existsSync(photos)) fs.cpSync(photos, UPLOADS, { recursive: true });
  fs.writeFileSync(READY, new Date().toISOString());
}

/** На порту уже кто-то отвечает? Одной пробы «занять порт» мало: если чужой сервер слушает все адреса (0.0.0.0, ::),
 *  и macOS, и Windows дают занять 127.0.0.1 на том же порту — и наш «здоров» ответил бы чужим голосом. */
function answers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

async function freePort(preferred) {
  const bindable = (port) => new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(null));
    probe.listen(port, "127.0.0.1", () => {
      const { port: got } = probe.address();
      probe.close(() => resolve(got));
    });
  });
  if (!(await answers(preferred)) && (await bindable(preferred))) return preferred;
  return bindable(0);                                  // любой свободный — система выдаст сама
}

function waitHealthy(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => (Date.now() > until
      ? reject(new Error(`Сервер склада не ответил за ${Math.round(timeoutMs / 60000)} мин.`))
      : setTimeout(probe, 500));
    const probe = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/actuator/health", timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => req.destroy());
    };
    probe();
  });
}

/** Сервер склада: тот же jar, что на сайте; интерфейс отдаёт сам, stdin закрылся — останавливается (DesktopConfig). */
async function startServer() {
  status("Запускаем склад…");
  const port = await freePort(APP_PORT);
  const serverLog = path.join(LOGS, "server.log");
  if (fs.existsSync(serverLog)) fs.renameSync(serverLog, path.join(LOGS, "server.prev.log"));
  const out = fs.openSync(serverLog, "w");
  const keys = ensureKeys();
  server = spawn(JAVA, ["-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-jar", path.join(RES, "server", "stock.jar")], {
    cwd: DATA,
    windowsHide: true,
    stdio: ["pipe", out, out],
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_ADDRESS: "127.0.0.1",
      DB_URL: `jdbc:postgresql://127.0.0.1:${PG_PORT}/${DB}`,
      DB_USER,
      DB_PASSWORD: pgEnv().PGPASSWORD,
      UPLOADS_DIR: UPLOADS,
      WEB_DIR: path.join(RES, "web"),
      EXIT_ON_STDIN_CLOSE: "true",
      SPRING_PROFILES_ACTIVE: "no-redis",   // Redis в коробке нет: кеш и счётчики — в памяти, сессии — в Tomcat
      CORS_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
      SITE_API_KEY: keys.SITE_API_KEY,
      SUPPLIER_API_KEY: keys.SUPPLIER_API_KEY,
    },
  });
  fs.closeSync(out);
  const died = new Promise((_, reject) => {
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Сервер склада остановился при запуске (код ${code}).\n\n${tail(serverLog)}`)));
  });
  await Promise.race([waitHealthy(port, 180_000), died]);
  log(`Склад работает: http://127.0.0.1:${port}/`);
  fs.writeFileSync(URL_FILE, `http://127.0.0.1:${port}`);    // адрес склада для сайта и портала — порт мог смениться
  return port;
}

/** Окно программы — одно на оба режима: в нём склад (origin) или своя страница «Подключение к складу». */
function createWindow() {
  const ours = (url) => origin !== null && sameSite(url, origin);
  const external = (url) => /^(https?|mailto):/i.test(url) && shell.openExternal(url);

  // Electron без обработчика разрешает странице всё подряд — здесь только нужное интерфейсу и только своим страницам
  session.defaultSession.setPermissionRequestHandler((_, permission, cb, details) =>
    cb(ours(details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_, permission, requestingOrigin) =>
    ours(requestingOrigin) && ALLOWED_PERMISSIONS.has(permission));

  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 360, minHeight: 480, show: false, title: "Флагман", icon: ICON,
    backgroundColor: "#ffffff",
    // preload отдаёт мост только своей странице с диска (connect.html), сайту склада — нет
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "connect-preload.js") },
  });
  // Свои страницы (этикетка, печать) — в окне программы; документация и сайты — в обычном браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ours(url)) return { action: "allow", overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true } };
    external(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!ours(url)) {
      e.preventDefault();
      external(url);
    }
  });
  win.once("ready-to-show", () => {
    if (SMOKE) return;
    win.maximize();
    win.show();
    splash?.close();
    splash = null;
  });
  win.on("closed", () => (win = null));
  // Ошибки страницы — в журнал запуска: по нему разбираться, если у человека «белый экран»
  win.webContents.on("console-message", (e, level, message) => {
    if ((e.level ?? level) === "error" || level === 3) log(`страница: ${e.message ?? message}`);
  });
  win.webContents.on("did-fail-load", (_, code, description, url, isMainFrame) => {
    log(`страница не загрузилась: ${code} ${description} ${url}`);
    // Сервер в интернете пропал — не белый экран, а «Подключение к складу» (−3 — просто отменённая загрузка)
    if (mode === "server" && isMainFrame && code !== -3 && !url.startsWith("file:")) {
      showConnect(`Нет связи со складом: ${origin}`);
    }
  });
  win.webContents.on("render-process-gone", (_, details) => log(`страница упала: ${details.reason}`));
}

function showWarehouse(url) {
  origin = url;
  buildMenu();
  win.loadURL(url + "/");
}

function showConnect(error) {
  connectError = error ?? null;
  win.loadFile(path.join(__dirname, "connect.html"));
}

/** Мост страницы подключения: отвечаем только своей странице с диска. */
function connectIpc() {
  const fromConnectPage = (e) => String(e.senderFrame?.url ?? "").startsWith("file:");
  ipcMain.handle("connect:info", (e) => (fromConnectPage(e)
    ? { serverUrl: mode === "server" ? (origin ?? loadSettings().serverUrl) : loadSettings().serverUrl,
        error: connectError, canGoBack: origin !== null }
    : null));
  ipcMain.handle("connect:try", async (e, raw) => {
    if (!fromConnectPage(e)) return { ok: false };
    const url = normalizeUrl(raw);
    if (!/^https?:\/\/[^\s/]+/i.test(url)) return { ok: false, error: "Адрес должен начинаться с http:// или https://" };
    if (!(await serverHealthy(url))) return { ok: false, error: `Склад по адресу ${url} не ответил. Проверьте адрес и интернет.` };
    saveSettings({ mode: "server", serverUrl: url });
    if (mode === "local") {
      await stopAll();                      // свой склад выключаем и перезапускаемся уже с сервером
      app.relaunch();
      app.exit(0);
    } else {
      showWarehouse(url);
    }
    return { ok: true };
  });
  ipcMain.handle("connect:back", (e) => {
    if (fromConnectPage(e) && origin) win.loadURL(origin + "/");
  });
  ipcMain.handle("connect:local", async (e) => {
    if (fromConnectPage(e)) await switchToLocal(false);
  });
}

async function switchToLocal(ask) {
  if (ask) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question", title: "Флагман", message: "Работать без сервера?",
      detail: "Программа запустит свой склад на этом компьютере — со своей базой. Данные не общие с телефоном и сайтом. "
        + "Вернуться к серверу — «Флагман → Подключиться к серверу…».",
      buttons: ["Работать без сервера", "Отмена"], defaultId: 0, cancelId: 1,
    });
    if (response !== 0) return;
  }
  saveSettings({ mode: "local" });
  app.relaunch();
  app.exit(0);
}

/** Адрес кассы — со склада (настройка «Адрес кассы», /api/auth/config): переедет сервер — переедет и ссылка. */
async function openPanel(page) {
  try {
    const cfg = JSON.parse((await fetchText(`${origin}/api/auth/config`)).body);
    if (!cfg.posUrl) throw new Error("не задан");
    shell.openExternal(page === "site" ? new URL(cfg.posUrl).origin + "/" : cfg.posUrl);
  } catch {
    dialog.showMessageBox(win, {
      type: "info", title: "Флагман", message: "Адрес кассы не настроен",
      detail: "Админ задаёт его в складе: «Админка → Настройки → Адрес кассы».",
    });
  }
}

function buildMenu() {
  const server = mode === "server";
  const items = server ? [
    { label: `Склад: ${origin ?? loadSettings().serverUrl}`, enabled: false },
    { label: "Открыть в браузере", click: () => origin && shell.openExternal(origin + "/") },
    { type: "separator" },
    { label: "Сайт кафе ИСТОК", click: () => origin && openPanel("site") },
    { label: "Касса (панель ресторана)", click: () => origin && openPanel("panel") },
    { type: "separator" },
    { label: "Адрес сервера…", click: () => showConnect(null) },
    { label: "Работать без сервера (свой склад на этом компьютере)…", click: () => switchToLocal(true) },
  ] : [
    { label: "Склад: этот компьютер", enabled: false },
    { label: "Открыть в браузере", click: () => shell.openExternal(origin.replace("127.0.0.1", "localhost") + "/") },
    { type: "separator" },
    { label: "Сайт кафе ИСТОК", click: () => openSite(3001, "/", "start-cafe.bat") },
    { label: "Касса (панель ресторана)", click: () => openSite(3001, "/panel/login.html", "start-cafe.bat") },
    { label: "Портал поставщика", click: () => openSite(3002, "/", "start-supplier.bat") },
    { type: "separator" },
    { label: "Подключиться к серверу…", click: () => showConnect(null) },
    { label: "Папка с данными", click: () => shell.openPath(DATA) },
    { label: "Журналы запуска", click: () => shell.openPath(LOGS) },
    { type: "separator" },
    { label: "Вернуть базу к исходной…", click: resetData },
  ];
  const template = [
    {
      label: "Флагман",
      submenu: [...items, { type: "separator" }, { label: "Выход", accelerator: "CmdOrCtrl+Q", click: () => app.quit() }],
    },
    ...(WIN ? [] : [{ role: "editMenu", label: "Правка" }]),     // на маке без «Правки» не работают ⌘C/⌘V
    {
      label: "Вид",
      submenu: [
        { role: "reload", label: "Обновить" },
        { role: "forceReload", label: "Обновить полностью" },
        { type: "separator" },
        { role: "resetZoom", label: "Обычный масштаб" },
        { role: "zoomIn", label: "Крупнее" },
        { role: "zoomOut", label: "Мельче" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Во весь экран" },
        { role: "toggleDevTools", label: "Инструменты разработчика" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Папка, которую видит человек: Flagman.exe-запускатель, батники, README; само окно склада — в её app\. */
const rootDir = () => (app.isPackaged ? path.dirname(path.dirname(process.execPath)) : path.join(__dirname, "win"));

/** Сайт и портал запускаются батниками рядом с Flagman.exe — отдельными окнами; не запущен — подсказываем какой. */
async function openSite(port, page, bat) {
  if (await answers(port)) {
    shell.openExternal(`http://localhost:${port}${page}`);
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    title: "Флагман",
    message: "Сайт ещё не запущен",
    detail: `Запустите ${bat} из папки offline рядом с Flagman.exe — откроется окно сервера (его не закрывайте) `
      + "и сама страница в браузере.",
    buttons: ["Открыть папку offline", "Закрыть"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openPath(path.join(rootDir(), "offline"));
}

async function resetData() {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Флагман",
    message: "Вернуть базу к исходной?",
    detail: "Всё, что сделано в программе на этом компьютере — заказы, приёмки, списания, новые сотрудники, — удалится. "
      + "Склад откроется в том виде, в каком его прислали.",
    buttons: ["Вернуть", "Отмена"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  fs.rmSync(READY, { force: true });                  // при следующем старте база зальётся из дампа заново
  await stopAll();
  app.relaunch();
  app.exit(0);
}

/** Остановка: сервер — закрытым stdin (штатно, со сбросом соединений), база — pg_ctl stop. */
function stopAll() {
  stopping ??= (async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once("exit", r));
      server.stdin.end();
      if (!(await Promise.race([exited.then(() => true), delay(15_000).then(() => false)]))) {
        log("Сервер не остановился за 15 с — завершаем принудительно");
        server.kill();
      }
    }
    if (URL_FILE) fs.rmSync(URL_FILE, { force: true });
    if (PGDATA && fs.existsSync(path.join(PGDATA, "postmaster.pid"))) {
      // Сайт кафе (start-cafe.bat) хранит заказы в этом же PostgreSQL: пока он работает, базу не выключаем
      const siteOnline = await run(bin("psql"), ["-d", "postgres", "-tAc",
        "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'istok%'"], { env: pgEnv() })
        .then((out) => Number(out.trim()) > 0, () => false);
      if (siteOnline) log("Сайт кафе ещё работает — база остаётся включённой (выключить — stop-db.bat)");
      else await run(bin("pg_ctl"), ["stop", "-m", "fast", "-w", "-t", "30", "-D", PGDATA]).catch((e) => log(e.message));
    }
  })();
  return stopping;
}

async function fail(e) {
  log(`ОШИБКА: ${e.stack || e}`);
  if (SMOKE) {
    process.stdout.write(`SMOKE FAIL ${e.message}\n`);
  } else {
    splash?.close();
    const { response } = await dialog.showMessageBox({
      type: "error", title: "Флагман", message: "Склад не запустился",
      detail: `${e.message}\n\nЖурналы: ${LOGS ?? "—"}`,
      buttons: ["Открыть журналы", "Закрыть"], defaultId: 1, cancelId: 1,
    });
    if (response === 0 && LOGS) await shell.openPath(LOGS);
  }
  app.quit();
}

/** Проверка сборки: главная страница и страница React по прямой ссылке отдаются, API отвечает. */
async function smoke() {
  const get = (p) => fetchText(origin + p);
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once("did-finish-load", r) : r()));
  if (win.webContents.getURL().startsWith("file:")) {
    process.stdout.write(`SMOKE CONNECT-PAGE ${connectError}\n`);
    app.quit();
    return;
  }
  const page = await get("/kush/stock");
  const api = await get("/api/auth/me");
  // React рисует, когда загрузит меню и сессию, — ждём до 10 с, пока в #root появится разметка
  const rendered = await win.webContents.executeJavaScript(`new Promise((r) => {
    const t0 = Date.now();
    const check = () => {
      const html = document.getElementById("root")?.innerHTML.length ?? 0;
      if (html > 200 || Date.now() - t0 > 10000) r(html + " " + location.pathname + " " + document.readyState);
      else setTimeout(check, 250);
    };
    check();
  })`);
  const ok = page.status === 200 && page.body.includes('id="root"') && api.status !== 404 && parseInt(rendered, 10) > 200;
  process.stdout.write(`SMOKE ${ok ? "OK" : "FAIL"} page=${page.status} api=${api.status} rendered=${rendered} ${origin}\n`);
  app.quit();
}

/** Режим «сервер»: ничего не запускаем — проверяем склад в интернете и открываем его; не ответил — страница подключения. */
async function startServerMode(settings) {
  LOGS = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(LOGS, { recursive: true });
  splash?.webContents.executeJavaScript(`setHint(${JSON.stringify(`Склад: ${settings.serverUrl}`)})`).catch(() => {});
  status("Подключаемся к складу…");
  log(`Запуск: режим «сервер», ${settings.serverUrl}`);
  createWindow();
  buildMenu();
  if (await serverHealthy(settings.serverUrl)) {
    showWarehouse(settings.serverUrl);
  } else {
    showConnect(`Склад по адресу ${settings.serverUrl} не ответил. Проверьте интернет или смените адрес.`);
  }
}

/** Режим «этот компьютер»: своя база и свой сервер склада. */
async function startLocalMode() {
  initPaths();
  log(`Запуск: режим «этот компьютер», данные — ${DATA}, программа — ${RES}`);
  checkBundle();
  await ensureCluster();
  await startPg();
  await ensureData();
  const port = await startServer();
  server.on("exit", (code) => !stopping && fail(new Error(`Сервер склада неожиданно остановился (код ${code}).\n\n${tail(path.join(LOGS, "server.log"))}`)));
  createWindow();
  showWarehouse(`http://127.0.0.1:${port}`);
}

async function main() {
  app.setAppUserModelId("ru.sphere.flagman");
  connectIpc();
  splash = new BrowserWindow({
    width: 440, height: 300, frame: false, resizable: false, show: false, center: true, icon: ICON,
    backgroundColor: "#0d9488", webPreferences: { contextIsolation: true, sandbox: true },
  });
  await splash.loadFile(path.join(__dirname, "splash.html"));
  if (!SMOKE) splash.show();
  try {
    const settings = loadSettings();
    mode = process.env.FLAGMAN_MODE || settings.mode;
    if (mode === "local") await startLocalMode();
    else await startServerMode(settings);
    if (SMOKE) await smoke();
  } catch (e) {
    await fail(e);
  }
}

// Один экземпляр: второй запуск только показывает уже открытое окно — две копии не делят одну базу
// FLAGMAN_USERDATA — для проверок: свои настройки и профиль, не трогая настоящие
app.setPath("userData", process.env.FLAGMAN_USERDATA || path.join(app.getPath("appData"), "Flagman"));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = win ?? splash;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  });
  app.on("window-all-closed", () => {
    if (!splash) app.quit();
  });
  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    win?.hide();
    stopAll().finally(() => app.exit(0));
  });
  app.whenReady().then(main);
}
