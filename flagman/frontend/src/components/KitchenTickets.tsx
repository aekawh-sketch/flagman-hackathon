import { useState } from "react";
import { Badge, Box, Button, Flex, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuPrinter, LuRotateCw } from "react-icons/lu";
import { api } from "../api";
import { SOURCE, time } from "../format";
import type { KitchenTicket } from "../types";
import { Loading, Section } from "./ui";
import { notifyError, notifyOk } from "./Toaster";

export const TICKET_STATUS: Record<KitchenTicket["status"], { label: string; palette: string }> = {
  QUEUED: { label: "печатается…", palette: "gray" },
  PRINTED: { label: "напечатан", palette: "green" },
  SHOWN: { label: "на экране", palette: "blue" },
  FAILED: { label: "не напечатан", palette: "red" },
};

const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * «Печать здесь»: чек — на принтер этого компьютера (USB-термопринтер кухни ставится в системе как обычный
 * принтер). Лента 58 или 80 мм, моноширинный шрифт — как у сетевого чека. Печать — из скрытой рамки:
 * блокировщик всплывающих окон не мешает. Названия блюд экранируются — это текст из базы.
 */
export function printInBrowser(t: KitchenTicket, paperMm: number) {
  const lines = t.lines.map((l) => `<div class="l">${l.qty} × ${escHtml(l.name)}</div>`
    + l.items.map((i) => `<div class="s">— ${i.qty} × ${escHtml(i.name)}</div>`).join("")).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Кухня №${t.orderNumber}</title><style>
    @page { size: ${paperMm}mm auto; margin: 0 }
    body { margin: 0; padding: 3mm; width: ${paperMm - 6}mm; font: 13px/1.35 ui-monospace, Menlo, Consolas, monospace; color: #000 }
    h1 { font-size: 22px; text-align: center; margin: 0 0 2px } .c { text-align: center }
    hr { border: 0; border-top: 1px dashed #000; margin: 6px 0 } .l { font-weight: 700; font-size: 15px; margin-top: 3px }
    .s { padding-left: 14px }
  </style></head><body><h1>КУХНЯ №${t.orderNumber}</h1>
    <div class="c">${escHtml(SOURCE[t.source ?? ""] ?? t.source ?? "")} · ${time(t.createdAt)}</div><hr>${lines}<hr>
    <div class="c">Пробито в ${time(t.createdAt)}</div></body></html>`;
  const frame = document.createElement("iframe");
  Object.assign(frame.style, { position: "fixed", width: "0", height: "0", border: "0", right: "0", bottom: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const w = frame.contentWindow!;
  const done = () => frame.remove();
  w.onafterprint = done;
  setTimeout(done, 60_000);
  w.focus();
  w.print();
}

/** Один чек — как бумажный: номер крупно, блюда жирным, состав сета с отступом. */
function Ticket({ t, network, paperMm, onReprint }: {
  t: KitchenTicket; network: boolean; paperMm: number; onReprint: () => void;
}) {
  const st = TICKET_STATUS[t.status];
  return (
    <Stack gap="2" w={{ base: "64", md: "60" }} flexShrink={0} p="3" bg="bg.panel" borderWidth="1px" borderStyle="dashed"
           borderColor={t.status === "FAILED" ? "red.emphasized" : "border.emphasized"} rounded="sm" fontFamily="mono" textStyle="sm">
      <Box textAlign="center">
        <Text fontSize="xl" fontWeight="bold" lineHeight="1.2">КУХНЯ №{t.orderNumber}</Text>
        <Text textStyle="xs" color="fg.muted">{SOURCE[t.source ?? ""] ?? t.source} · {time(t.createdAt)}</Text>
      </Box>
      <Box borderTopWidth="1px" borderStyle="dashed" />
      <Stack gap="1">
        {t.lines.map((l, i) => (
          <Box key={i}>
            <Text fontWeight="bold">{l.qty} × {l.name}</Text>
            {l.items.map((s, j) => <Text key={j} pl="3" color="fg.muted">— {s.qty} × {s.name}</Text>)}
          </Box>
        ))}
      </Stack>
      <Box borderTopWidth="1px" borderStyle="dashed" />
      <Flex justify="space-between" align="center" gap="2" fontFamily="body">
        <Badge colorPalette={st.palette} variant="subtle">{st.label}</Badge>
        <Text textStyle="2xs" color="fg.subtle" truncate title={t.printer ?? ""}>{t.printer}</Text>
      </Flex>
      {t.error && <Text textStyle="xs" color="red.fg" fontFamily="body">{t.error}</Text>}
      <HStack gap="1" fontFamily="body">
        {network && (
          <Button size="xs" variant="outline" onClick={onReprint}><LuRotateCw /> Ещё раз</Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => printInBrowser(t, paperMm)} title="На принтер этого компьютера">
          <LuPrinter /> Печать здесь
        </Button>
      </HStack>
    </Stack>
  );
}

/** Отрезок времени ленты: день и часы «с — по» (по часам этого компьютера кухни); null — последние чеки. */
interface Range { date: string; from: string; to: string }

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Границы для сервера: «по» пусто — до конца дня; «по» раньше «с» — ошибка, а не пустой список. */
function bounds(r: Range): { from: string; to: string } | { error: string } {
  const from = new Date(`${r.date}T${r.from || "00:00"}`);
  const to = r.to ? new Date(`${r.date}T${r.to}`) : new Date(new Date(`${r.date}T00:00`).getTime() + 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: "Выберите день" };
  if (to <= from) return { error: "Время «по» должно быть позже «с»" };
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Фильтр ленты: день и время «с — по», быстрые «Последние», «Сегодня», «Последний час». */
function TicketFilter({ range, onChange }: { range: Range | null; onChange: (r: Range | null) => void }) {
  const r = range ?? { date: today(), from: "", to: "" };
  const set = (patch: Partial<Range>) => onChange({ ...r, ...patch });
  const lastHour = () => {
    const now = new Date();
    const from = new Date(now.getTime() - 3_600_000);
    onChange(from.getDate() === now.getDate() ? { date: today(), from: hhmm(from), to: "" } : { date: today(), from: "00:00", to: "" });
  };
  return (
    <Flex gap="2" align="end" wrap="wrap" mb="3">
      <HStack gap="1" wrap="wrap">
        <Button size="sm" variant={range ? "outline" : "solid"} colorPalette="teal" onClick={() => onChange(null)}>Последние</Button>
        <Button size="sm" variant="outline" onClick={() => onChange({ date: today(), from: "", to: "" })}>Сегодня</Button>
        <Button size="sm" variant="outline" onClick={lastHour}>Последний час</Button>
      </HStack>
      <HStack gap="2" wrap="wrap" align="end">
        <Stack gap="0.5">
          <Text textStyle="xs" color="fg.muted">День</Text>
          <Input size="sm" type="date" w="40" value={r.date} max={today()} onChange={(e) => set({ date: e.target.value })} aria-label="День" />
        </Stack>
        <Stack gap="0.5">
          <Text textStyle="xs" color="fg.muted">с</Text>
          <Input size="sm" type="time" w="28" value={r.from} onChange={(e) => set({ from: e.target.value })} aria-label="Время с" />
        </Stack>
        <Stack gap="0.5">
          <Text textStyle="xs" color="fg.muted">по</Text>
          <Input size="sm" type="time" w="28" value={r.to} onChange={(e) => set({ to: e.target.value })} aria-label="Время по" />
        </Stack>
      </HStack>
    </Flex>
  );
}

/**
 * Лента чеков на кухню (ТЗ 16.15): кассир пробил заказ — здесь появляется чек, на сетевом принтере он печатается
 * сам. Не напечатался — красная рамка и «Ещё раз»; USB-принтер у компьютера кухни — «Печать здесь».
 * Фильтр (ТЗ 16.18): день и время «с — по» — найти чек за смену или за конкретный час.
 */
export function KitchenTickets({ loc }: { loc: string }) {
  const qc = useQueryClient();
  const [range, setRange] = useState<Range | null>(null);
  const b = range ? bounds(range) : null;
  const err = b && "error" in b ? b.error : null;
  const span = b && !("error" in b) ? b : null;
  const tickets = useQuery({
    queryKey: ["kitchen-tickets", loc, span?.from, span?.to],
    queryFn: () => (span ? api.kitchenTickets(loc, 100, span.from, span.to) : api.kitchenTickets(loc, 12)),
    enabled: !err,
  });
  const printer = useQuery({ queryKey: ["kitchen-printer", loc], queryFn: () => api.kitchenPrinter(loc), retry: false });
  const p = printer.data;
  const network = p?.mode === "NETWORK";
  const reprint = async (t: KitchenTicket) => {
    try {
      const r = await api.reprintTicket(loc, t.id);
      if (r.status === "FAILED") notifyError(new Error(r.error ?? "Принтер не ответил"));
      else notifyOk(`Чек №${t.orderNumber} напечатан`, r.printer);
    } catch (e) {
      notifyError(e);
    } finally {
      qc.invalidateQueries({ queryKey: ["kitchen-tickets", loc] });
    }
  };
  const where = !p ? "" : p.mode === "NETWORK" ? `принтер ${p.host}:${p.port}` : p.mode === "SCREEN" ? "без принтера — на экране" : "печать выключена";
  return (
    <Section title="Чеки на кухню" actions={where && (
      <HStack gap="1.5" color="fg.muted" textStyle="xs"><LuPrinter /><Text>{where}</Text></HStack>)}>
      <TicketFilter range={range} onChange={setRange} />
      {err ? <Text color="red.fg" textStyle="sm">{err}</Text> : tickets.isLoading ? <Loading rows={2} /> : !tickets.data?.length ? (
        <Text color="fg.muted">{range ? "За это время чеков нет" : "Чеков пока нет — они появятся, когда касса пробьёт заказ"}</Text>
      ) : (
        <>
        {range && (
          <Text textStyle="xs" color="fg.muted" mb="2">
            Найдено чеков: {tickets.data.length}{tickets.data.length === 100 ? " (показаны последние 100 — сузьте время)" : ""}
          </Text>
        )}
        <Flex gap="3" overflowX="auto" pb="2" align="start">
          {tickets.data.map((t) => (
            <Ticket key={t.id} t={t} network={network} paperMm={p?.paperMm ?? 80} onReprint={() => reprint(t)} />
          ))}
        </Flex>
        </>
      )}
    </Section>
  );
}
