import { useState } from "react";
import { Button, Flex, HStack, Input, Text } from "@chakra-ui/react";
import { useServerNow } from "../session";

/** Дата «ГГГГ-ММ-ДД» по местному времени. */
export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));

export interface Period { from: string; to: string }

/** День «ГГГГ-ММ-ДД» минус n дней — календарно, без часовых поясов. */
export const minusDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const MSK = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" });

/**
 * «Сегодня» по часам сервера, в часовом поясе точки: в демо-режиме время может идти с ускорением и быть впереди
 * компьютера — периоды «7 дней», «сегодня» должны считаться от него, иначе свежие записи не попадают в выборку.
 */
export function useServerToday(): string {
  return MSK.format(new Date(useServerNow()));
}

/** Последние n дней по сегодня включительно: n = 7 — сегодня и шесть дней до него. */
export const lastDays = (n: number, today = isoDay(new Date())): Period => ({ from: minusDays(today, n - 1), to: today });

/**
 * Период страницы: пока его не выбрали — «последние n дней» по серверному «сегодня» (и сдвигается вместе с ним),
 * после выбора — то, что выбрали.
 */
export function usePeriod(defaultDays: number): [Period, (p: Period) => void] {
  const today = useServerToday();
  const [custom, setCustom] = useState<Period | null>(null);
  return [custom ?? lastDays(defaultDays, today), setCustom];
}

/** «сегодня», «за 12.10» или «за 07.10 — 13.10» — подпись к показателям периода. */
export function periodLabel(p: Period, today = isoDay(new Date())) {
  const f = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  if (p.from === p.to) return p.to === today ? "сегодня" : `за ${f(p.to)}`;
  return `за ${f(p.from)} — ${f(p.to)}`;
}

/** Неделя по последний день периода — когда период один день, а графику нужна динамика. */
export const weekEnding = (p: Period): Period => ({ from: minusDays(p.to, 6), to: p.to });

/** Сколько дней в периоде (включительно). */
export const periodDays = (p: Period) =>
  Math.max(1, Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1);

/**
 * Календарь периода «с … по …» и быстрые кнопки. Дни включительно: «по 13.10» — весь день 13 октября.
 */
export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const today = useServerToday();
  const presets: { label: string; p: Period }[] = [
    { label: "Сегодня", p: lastDays(1, today) },
    { label: "7 дней", p: lastDays(7, today) },
    { label: "30 дней", p: lastDays(30, today) },
    { label: "Этот месяц", p: { from: `${today.slice(0, 8)}01`, to: today } },
  ];
  const same = (p: Period) => p.from === value.from && p.to === value.to;
  return (
    <Flex gap="2" align="center" wrap="wrap">
      <HStack gap="2">
        <Text textStyle="sm" color="fg.muted">с</Text>
        <Input type="date" size="sm" w="38" value={value.from} max={value.to} aria-label="Период: с"
               onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
        <Text textStyle="sm" color="fg.muted">по</Text>
        <Input type="date" size="sm" w="38" value={value.to} min={value.from} aria-label="Период: по"
               onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
      </HStack>
      <HStack gap="1" wrap="wrap">
        {presets.map((x) => (
          <Button key={x.label} size="xs" variant={same(x.p) ? "subtle" : "ghost"} colorPalette={same(x.p) ? "teal" : "gray"}
                  onClick={() => onChange(x.p)}>{x.label}</Button>
        ))}
      </HStack>
    </Flex>
  );
}
