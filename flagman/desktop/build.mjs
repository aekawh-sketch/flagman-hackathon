// Сборка «Флагмана» для Windows на маке: node build.mjs → out/Flagman-win-x64.zip.
//
//   1. сервер склада (backend → stock.jar) и интерфейс (frontend → dist);
//   2. Java 25 и PostgreSQL 16 для Windows (скачиваются один раз в .cache, контрольные суммы закреплены);
//   3. окно-оболочка Electron для win32-x64 и архив.
//
// Данные склада скрипт не трогает: что положено в stage/seed (flagman.dump и папка uploads), то и поедет
// в архив. Папки нет — программа при первом запуске сама создаст демо-ресторан.
//
// Флаги: --skip-backend, --skip-frontend — взять готовое из stage/; --stage-only — только stage/
// (для проверки на маке: FLAGMAN_PG_BIN=… FLAGMAN_JAVA=… npm start).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DESKTOP, "..");
const CACHE = path.join(DESKTOP, ".cache");
const STAGE = path.join(DESKTOP, "stage");
const OUT = path.join(DESKTOP, "out");
const flags = new Set(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, "package.json"), "utf8"));

const RUNTIMES = {
  jre: {
    file: "jre-win-x64.zip",
    url: "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_windows_hotspot_25.0.4.1_1.zip",
    sha256: "4c95451cea98556def2c54f7782933f52a26d4a36bd85e1d59f0364464828b07",
  },
  pgsql: {
    file: "pgsql-win-x64.zip",
    url: "https://get.enterprisedb.com/postgresql/postgresql-16.13-1-windows-x64-binaries.zip",
    sha256: "9b4c7a1bc31147b5b2ba59178d0eef86c16181d54a20177192b387dff20f00a9",
  },
  // Сайт ИСТОК и портал поставщика (manual\start-site.bat, start-supplier.bat) — на Node; из архива нужен один node.exe
  node: {
    file: "node-win-x64.zip",
    url: "https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip",
    sha256: "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71",
    exe: "node-v22.23.3-win-x64/node.exe",
  },
};

const step = (text) => console.log(`\n▸ ${text}`);
const sh = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function download({ file, url, sha256: expected }) {
  const dest = path.join(CACHE, file);
  if (!fs.existsSync(dest)) {
    console.log(`  скачиваем ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  const actual = sha256(dest);
  if (actual !== expected) {
    throw new Error(`${file}: контрольная сумма ${actual}, ожидалась ${expected} — удалите файл из .cache и соберите заново`);
  }
  return dest;
}

/** Java для Windows: архив как есть, папка — runtime/jre. */
async function stageJre(runtime) {
  const dest = path.join(runtime, "jre");
  if (fs.existsSync(path.join(dest, "bin", "java.exe"))) return;
  const zip = await download(RUNTIMES.jre);
  const tmp = path.join(runtime, ".jre-tmp");
  rm(tmp);
  sh("unzip", ["-q", zip, "-d", tmp]);
  const [top] = fs.readdirSync(tmp).filter((d) => !d.startsWith("."));
  rm(dest);
  fs.renameSync(path.join(tmp, top), dest);
  rm(tmp);
}

/**
 * PostgreSQL для Windows без лишнего: pgAdmin, StackBuilder, документация и заголовки — это 4/5 архива.
 * Библиотек Visual C++ в архиве нет (их ставит установщик EDB) — кладём те же, что идут с Java.
 */
async function stagePgsql(runtime) {
  const dest = path.join(runtime, "pgsql");
  if (fs.existsSync(path.join(dest, "bin", "postgres.exe"))) return;
  const zip = await download(RUNTIMES.pgsql);
  rm(dest);
  sh("unzip", ["-q", zip, "-x", "pgsql/pgAdmin*", "pgsql/doc/*", "pgsql/include/*", "pgsql/StackBuilder/*", "pgsql/symbols/*",
    "-d", runtime]);
  const binDir = path.join(dest, "bin");
  for (const f of fs.readdirSync(binDir)) {
    if (/^wx.*\.dll$/i.test(f) || /^stackbuilder\.exe$/i.test(f)) rm(path.join(binDir, f));
  }
  const libDir = path.join(dest, "lib");
  for (const f of fs.readdirSync(libDir)) {
    if (/\.lib$/i.test(f) || f === "pgxs" || f === "pkgconfig") rm(path.join(libDir, f));
  }
  for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]) {
    fs.copyFileSync(path.join(runtime, "jre", "bin", dll), path.join(binDir, dll));
  }
}

async function stageNode(runtime) {
  const dest = path.join(runtime, "node");
  if (fs.existsSync(path.join(dest, "node.exe"))) return;
  const zip = await download(RUNTIMES.node);
  rm(dest);
  sh("unzip", ["-q", "-j", zip, RUNTIMES.node.exe, "-d", dest]);
}

/**
 * Сайт ИСТОК (../istok: server, site, seed/menu.json) и портал поставщика (../supplier) — только код и статика.
 * Не едут: .env и другие скрытые файлы (ключи этого компьютера — у друга свои, из keys.env), выгрузки заказов
 * server/orders, инструменты разработки. Зависимости сайта ставятся заново по package-lock — без dev-пакетов.
 */
function stageSites() {
  const sites = path.join(STAGE, "sites");
  rm(sites);
  const copy = (from, to, skip = []) => fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return src === from || (!name.startsWith(".") && !skip.includes(name));
    },
  });
  const istok = path.resolve(ROOT, "..", "istok");
  copy(path.join(istok, "server"), path.join(sites, "istok", "server"), ["node_modules", "orders"]);
  copy(path.join(istok, "site"), path.join(sites, "istok", "site"), ["tools"]);
  fs.mkdirSync(path.join(sites, "istok", "seed"), { recursive: true });
  fs.copyFileSync(path.join(istok, "seed", "menu.json"), path.join(sites, "istok", "seed", "menu.json"));
  sh("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(sites, "istok", "server"));

  const supplier = path.resolve(ROOT, "..", "supplier");
  copy(supplier, path.join(sites, "supplier"), ["node_modules", "README.md"]);
}

/** Иконка из favicon склада: PNG для окна и ICO (PNG внутри, 16–256 px) для Flagman.exe. */
async function icons() {
  const assets = path.join(DESKTOP, "assets");
  if (fs.existsSync(path.join(assets, "icon.ico"))) return;
  const { Resvg } = await import("@resvg/resvg-js");
  const svg = fs.readFileSync(path.join(ROOT, "frontend", "public", "favicon.svg"));
  const png = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => ({ size, data: png(size) }));
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size % 256, o);           // 256 записывается как 0
    head.writeUInt8(size % 256, o + 1);
    head.writeUInt16LE(1, o + 4);             // плоскости
    head.writeUInt16LE(32, o + 6);            // бит на пиксель
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "icon.ico"), Buffer.concat([head, ...images.map((i) => i.data)]));
  fs.writeFileSync(path.join(assets, "icon.png"), png(256));
}

/**
 * Flagman.exe в корне — запускатель app\Flagman.exe (win/launcher: 30 строк на C, собран Zig один раз).
 * Иконка и описание — те же, что у окна склада: Проводник и панель задач показывают одну программу.
 */
async function launcher(dest) {
  const ResEdit = await import("resedit");
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(path.join(DESKTOP, "win", "launcher", "Flagman.exe")));
  const res = ResEdit.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(DESKTOP, "assets", "icon.ico")));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.createEmpty();
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    CompanyName: "Флагман", ProductName: "Флагман", FileDescription: "Флагман — склад ресторана",
    OriginalFilename: "Flagman.exe", InternalName: "Flagman", LegalCopyright: "© 2026 Флагман",
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(dest, Buffer.from(exe.generate()));
}

async function main() {
  fs.mkdirSync(STAGE, { recursive: true });

  if (!flags.has("--skip-backend")) {
    step("Сервер склада (backend → stock.jar)");
    sh(path.join(ROOT, "backend", "mvnw"), ["-q", "-DskipTests", "package"], path.join(ROOT, "backend"));
    const jar = fs.readdirSync(path.join(ROOT, "backend", "target")).find((f) => /^stock-.*\.jar$/.test(f));
    if (!jar) throw new Error("backend/target: нет stock-*.jar");
    fs.mkdirSync(path.join(STAGE, "server"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "backend", "target", jar), path.join(STAGE, "server", "stock.jar"));
  }

  if (!flags.has("--skip-frontend")) {
    step("Интерфейс (frontend → web)");
    sh("npm", ["run", "build"], path.join(ROOT, "frontend"));
    rm(path.join(STAGE, "web"));
    fs.cpSync(path.join(ROOT, "frontend", "dist"), path.join(STAGE, "web"), { recursive: true });
  }

  step("Java 25 и PostgreSQL 16 для Windows");
  const runtime = path.join(STAGE, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  await stageJre(runtime);
  await stagePgsql(runtime);
  await stageNode(runtime);
  await icons();

  step("Сайт ИСТОК и портал поставщика");
  stageSites();

  const seed = path.join(STAGE, "seed");
  fs.mkdirSync(seed, { recursive: true });
  console.log(fs.existsSync(path.join(seed, "flagman.dump"))
    ? "  данные: stage/seed/flagman.dump — поедут в архив"
    : "  данных нет (stage/seed/flagman.dump) — программа создаст демо-ресторан при первом запуске");
  if (flags.has("--stage-only")) return;

  step("Окно программы (Electron → Windows x64)");
  const { packager } = await import("@electron/packager");
  rm(OUT);
  const [built] = await packager({
    dir: DESKTOP,
    out: OUT,
    platform: "win32",
    arch: "x64",
    electronVersion: pkg.devDependencies.electron,
    name: "Flagman",
    executableName: "Flagman",
    appVersion: pkg.version,
    appCopyright: "© 2026 Флагман",
    icon: path.join(DESKTOP, "assets", "icon.ico"),
    asar: true,
    overwrite: true,
    ignore: [/^\/(stage|out|\.cache|win)(\/|$)/, /^\/build\.mjs$/, /^\/\.gitignore$/],
    extraResource: ["runtime", "server", "web", "seed", "sites"].map((d) => path.join(STAGE, d)),
    win32metadata: {
      CompanyName: "Флагман",
      ProductName: "Флагман",
      FileDescription: "Флагман — склад ресторана",
      OriginalFilename: "Flagman.exe",
      InternalName: "Flagman",
    },
  });

  // Языки Chromium: нужны русский (меню «Копировать», «Вставить») и английский — остальные 50 МБ не нужны
  const locales = path.join(built, "locales");
  for (const f of fs.readdirSync(locales)) {
    if (f !== "ru.pak" && f !== "en-US.pak") rm(path.join(locales, f));
  }
  fs.cpSync(path.join(DESKTOP, "win", "app-tools"), path.join(built, "tools"), { recursive: true });

  // Что видит человек: Flagman.exe, батники и README; два десятка файлов Electron — в app\
  step("Папка программы");
  const folder = path.join(OUT, "Flagman");
  fs.mkdirSync(folder);
  fs.renameSync(built, path.join(folder, "app"));
  await launcher(path.join(folder, "Flagman.exe"));
  for (const f of fs.readdirSync(path.join(DESKTOP, "win"))) {
    if (/\.(bat|txt)$/i.test(f)) fs.copyFileSync(path.join(DESKTOP, "win", f), path.join(folder, f));
  }
  // Батники режима «без сервера» (свой склад на компьютере) — отдельной папкой, чтобы не путать с Open-*.bat
  fs.cpSync(path.join(DESKTOP, "win", "offline"), path.join(folder, "offline"), { recursive: true });
  console.log(`  ${fs.readdirSync(folder).join("  ")}`);

  step("Архив");
  sh("zip", ["-r", "-X", "-q", "-9", "Flagman-win-x64.zip", "Flagman", "-x", "*.DS_Store"], OUT);
  const size = fs.statSync(path.join(OUT, "Flagman-win-x64.zip")).size;
  console.log(`\n✓ ${path.join(OUT, "Flagman-win-x64.zip")} — ${(size / 1024 / 1024).toFixed(0)} МБ`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
