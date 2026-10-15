import type { BatchStatus, Role } from "./types";

/** Неразрывный пробел между числом и единицей: «2 309 ₽» и «1,5 кг» не разъезжаются на две строки. */
export const NB = "\u00A0";

/** Склеить число с единицей в готовом тексте: «Капучино 200 мл» — «200 мл» не разрываются. */
export const glue = (s: string) => s.replace(/(\d) (?=(мл|л|г|кг|см|шт|ч|мин|₽)(?![а-яё]))/gi, `$1${NB}`).replace(/ ×/g, `${NB}×`);

const rub = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const rub2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const money = (kop: number) => `${rub.format(Math.round(kop / 100))}${NB}₽`;
export const moneyExact = (kop: number) => `${rub2.format(kop / 100)}${NB}₽`;

export function qty(value: number, unit: string): string {
  if (unit === "PCS") return `${value}${NB}шт`;
  const [small, big] = unit === "ML" ? ["мл", "л"] : ["г", "кг"];
  if (Math.abs(value) < 1000) return `${value}${NB}${small}`;
  const v = value / 1000;
  return `${Number.isInteger(v) ? v : v.toFixed(1).replace(".", ",")}${NB}${big}`;
}

/** «через 3 ч», «через 25 мин», «2 дн.»; отрицательное — «просрочено». */
export function timeLeft(hours: number): string {
  if (hours <= 0) return "просрочено";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}${NB}мин`;
  if (hours < 48) return `${Math.round(hours)}${NB}ч`;
  return `${Math.round(hours / 24)}${NB}дн.`;
}

/** Склонение по числу: plural(3, ["строка", "строки", "строк"]) → «строки». */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  return b >= 2 && b <= 4 ? few : many;
}

export const hoursBetween = (from: number, toIso: string) => (Date.parse(toIso) - from) / 3_600_000;

const dt = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit",
  hour: "2-digit", minute: "2-digit" });
const dty = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit" });
const tm = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
const dOnly = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long",
  weekday: "short" });

export const dateTime = (iso: string | number) => dt.format(new Date(iso));
/** С годом — где дата живёт долго: срок годности партии и этикетка (консервы, заморозка — на месяцы вперёд). */
export const dateTimeYear = (iso: string | number) => dty.format(new Date(iso));
export const time = (iso: string | number) => tm.format(new Date(iso));
export const dayLabel = (iso: string | number) => dOnly.format(new Date(iso));

export const STATUS: Record<BatchStatus | "BLOCKED", { label: string; palette: string }> = {
  FRESH: { label: "свежая", palette: "green" },
  SOON: { label: "скоро истекает", palette: "yellow" },
  CRITICAL: { label: "критично", palette: "orange" },
  EXPIRED: { label: "под списание", palette: "red" },
  BLOCKED: { label: "заблокирована", palette: "gray" },
};

export const ROLE: Record<Role, string> = {
  COOK: "Повар",
  CASHIER: "Кассир",
  STOREKEEPER: "Кладовщик",
  MANAGER: "Управляющий",
  ADMIN: "Админ",
};

/** Что делает роль — подпись справа в списке выбора роли */
export const ROLE_HINT: Record<Role, string> = {
  COOK: "кухня, заготовки",
  CASHIER: "касса в панели ресторана",
  STOREKEEPER: "приёмка, пересчёт",
  MANAGER: "списания, отчёты",
  ADMIN: "сотрудники, меню, настройки",
};
/** Причины ручного списания — список выбора в заявке (просрочку списывают отдельно) */
export const WRITEOFF_REASONS = [
  { value: "SPOILED", label: "Порча", hint: "запах, плесень, испортилось" },
  { value: "DAMAGED", label: "Бой, пролив", hint: "упало, разбилось, протекло" },
  { value: "OTHER", label: "Прочее", hint: "нужен комментарий" },
];
export const roleOptions = () => (Object.keys(ROLE) as Role[]).map((r) => ({ value: r, label: ROLE[r], hint: ROLE_HINT[r] }));

export const ORDER_STATUS: Record<string, { label: string; palette: string }> = {
  NEW: { label: "новый", palette: "blue" },
  ACCEPTED: { label: "принят", palette: "cyan" },
  COOKING: { label: "готовится", palette: "orange" },
  READY: { label: "готов", palette: "teal" },
  DELIVERING: { label: "в пути", palette: "purple" },
  DONE: { label: "выдан", palette: "gray" },
  CANCELED: { label: "отменён", palette: "red" },
  CANCELED_LATE: { label: "отменён после готовки", palette: "red" },
};

export const SOURCE: Record<string, string> = {
  POS: "касса", SITE: "сайт", GENERATOR: "генератор", API: "API",
};

export const WRITEOFF_REASON: Record<string, string> = {
  SPOILED: "порча", DAMAGED: "бой, пролив", OTHER: "прочее",
};
