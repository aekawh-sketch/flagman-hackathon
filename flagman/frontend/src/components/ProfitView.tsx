import { useState } from "react";
import { Box, Button, Flex, HStack, SimpleGrid, Table, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { money, plural } from "../format";
import type { ProfitDay } from "../types";
import { Empty, Kpi, Loading, Section } from "./ui";

/**
 * Цвета серий — слоты 1 и 2 проверенной палитры (синий, оранжевый), проверены на цветовую слепоту для светлой
 * и тёмной темы; текст графика — цветами текста, не серий.
 */
const SERIES = {
  "--profit": "#2a78d6", "--net": "#eb6834",
  _dark: { "--profit": "#3987e5", "--net": "#d95926" },
} as const;
const LABELS = { gross: "Прибыль", net: "В плюсе" } as const;

const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")}%`;
const dayLabel = (iso: string) => iso.slice(5).split("-").reverse().join(".");

/** Подсказка дня: все четыре числа — выручка, прибыль, потери, «в плюсе». */
function DayTip({ active, payload }: { active?: boolean; payload?: { payload: ProfitDay & { day: string } }[] }) {
  const d = active && payload?.[0]?.payload;
  if (!d) return null;
  const row = (label: string, kop: number, swatch?: string) => (
    <HStack justify="space-between" gap="4">
      <HStack gap="1.5">
        {swatch && <Box boxSize="2.5" rounded="sm" bg={swatch} />}
        <Text color="fg.muted">{label}</Text>
      </HStack>
      <Text fontVariantNumeric="tabular-nums" fontWeight="medium">{money(kop)}</Text>
    </HStack>
  );
  return (
    <Box bg="bg.panel" borderWidth="1px" rounded="md" shadow="md" p="2.5" textStyle="xs" minW="44">
      <Text fontWeight="semibold" mb="1">{dayLabel(d.date)}</Text>
      {row("Выручка", d.revenueKop)}
      {row(LABELS.gross, d.grossKop, "var(--profit)")}
      {row("Потери", d.lossesKop)}
      {row(LABELS.net, d.netKop, "var(--net)")}
    </Box>
  );
}

/**
 * Второй режим «Аналитики» (ТЗ 16.18): прибыль за период.
 * Прибыль = выручка − себестоимость проданного (партии по FEFO); «в плюсе» = прибыль − потери
 * (списания, просрочка, отмены после готовки). Аренду, зарплаты и налоги склад не знает.
 */
export function ProfitView({ loc, days, from, to }: { loc: string; days: number; from?: string; to?: string }) {
  const q = useQuery({ queryKey: ["profit", loc, from, to, days], queryFn: () => api.profit(loc, days, from, to) });
  const [asTable, setAsTable] = useState(false);
  const [allDishes, setAllDishes] = useState(false);
  const p = q.data;
  if (!p) return <Loading rows={4} />;
  const rows = p.byDay.map((d) => ({ ...d, day: dayLabel(d.date), gross: Math.round(d.grossKop / 100), net: Math.round(d.netKop / 100) }));
  const dishes = p.byDish.filter((x) => x.variantId);
  const loose = p.byDish.find((x) => !x.variantId);
  const shown = allDishes ? dishes : dishes.slice(0, 15);

  return (
    <Box css={SERIES}>
      <SimpleGrid columns={{ base: 2, md: 3, xl: 5 }} gap="3" mb="2">
        <Kpi label="Выручка" value={money(p.revenueKop)} hint={`${p.orders} ${plural(p.orders, ["заказ", "заказа", "заказов"])}`} />
        <Kpi label="Себестоимость" value={money(p.costKop)} hint="партии, ушедшие в заказы" />
        <Kpi label={LABELS.gross} value={money(p.grossKop)} hint={`${pct(p.grossShare)} от выручки`} palette={p.grossKop < 0 ? "red" : undefined} />
        <Kpi label="Потери" value={money(p.lossesKop)} palette="red" hint="списания и поздние отмены" />
        <Kpi label={LABELS.net} value={money(p.netKop)} hint={`${pct(p.netShare)} от выручки`} palette={p.netKop < 0 ? "red" : "green"} />
      </SimpleGrid>
      <Text textStyle="xs" color="fg.muted" mb="4">
        Прибыль — выручка минус себестоимость проданного: склад знает, из каких партий и по какой цене ушло каждое блюдо.
        «В плюсе» — прибыль за вычетом потерь: списаний, просрочки и отмен после готовки. Аренды, зарплат и налогов склад
        не знает — их здесь нет.
      </Text>

      <Section mb="4" title="Прибыль по дням" actions={
        <Button size="xs" variant="ghost" onClick={() => setAsTable((v) => !v)}>{asTable ? "Графиком" : "Таблицей"}</Button>}>
        {!p.revenueKop && !p.lossesKop ? <Empty title="Продаж и потерь за период не было" /> : asTable ? (
          <Table.ScrollArea>
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>День</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Выручка</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">{LABELS.gross}</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Потери</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">{LABELS.net}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {p.byDay.map((d) => (
                  <Table.Row key={d.date}>
                    <Table.Cell>{dayLabel(d.date)}</Table.Cell>
                    <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{money(d.revenueKop)}</Table.Cell>
                    <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{money(d.grossKop)}</Table.Cell>
                    <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{money(d.lossesKop)}</Table.Cell>
                    <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums" color={d.netKop < 0 ? "red.fg" : undefined}>{money(d.netKop)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Table.ScrollArea>
        ) : (
          <>
            {/* Две серии — легенда всегда видна; цвет не единственный признак: подписи и порядок столбиков постоянны */}
            <HStack gap="4" mb="2" textStyle="xs" color="fg.muted">
              <HStack gap="1.5"><Box boxSize="2.5" rounded="sm" bg="var(--profit)" /><Text>{LABELS.gross} — левый столбик</Text></HStack>
              <HStack gap="1.5"><Box boxSize="2.5" rounded="sm" bg="var(--net)" /><Text>{LABELS.net} — правый</Text></HStack>
            </HStack>
            <Box h="260px">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} barGap={2} barCategoryGap="22%">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chakra-colors-border)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: "var(--chakra-colors-fg-muted)" }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--chakra-colors-fg-muted)" }} width={56} tickLine={false} axisLine={false}
                         tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)} тыс` : String(v))} />
                  <ReferenceLine y={0} stroke="var(--chakra-colors-border-emphasized)" />
                  <Tooltip content={<DayTip />} cursor={{ fill: "var(--chakra-colors-bg-muted)" }} />
                  <Bar dataKey="gross" name={LABELS.gross} fill="var(--profit)" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  <Bar dataKey="net" name={LABELS.net} fill="var(--net)" radius={[4, 4, 0, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          </>
        )}
      </Section>

      <Section title="Прибыль по блюдам" actions={<Text textStyle="xs" color="fg.muted">себестоимость — из партий, ушедших в порции</Text>}>
        {!dishes.length ? <Empty title="Продаж за период не было" /> : (
          <>
            <Table.ScrollArea>
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Блюдо</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Продано</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end" hideBelow="md">Выручка</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end" hideBelow="md">Себестоимость</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Прибыль</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Маржа</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {shown.map((x) => (
                    <Table.Row key={x.variantId}>
                      <Table.Cell>
                        <Text fontWeight="medium">{x.name}</Text>
                        <Text hideFrom="md" textStyle="xs" color="fg.muted">{money(x.revenueKop)} − {money(x.costKop)}</Text>
                      </Table.Cell>
                      <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums">{x.qty}</Table.Cell>
                      <Table.Cell textAlign="end" hideBelow="md" fontVariantNumeric="tabular-nums">{money(x.revenueKop)}</Table.Cell>
                      <Table.Cell textAlign="end" hideBelow="md" fontVariantNumeric="tabular-nums">{money(x.costKop)}</Table.Cell>
                      <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums" fontWeight="medium"
                                  color={x.profitKop < 0 ? "red.fg" : undefined}>{money(x.profitKop)}</Table.Cell>
                      <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums" color={x.margin < 0 ? "red.fg" : "fg.muted"}>{pct(x.margin)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Table.ScrollArea>
            <Flex justify="space-between" align="center" mt="2" gap="3" wrap="wrap">
              {loose ? (
                <Text textStyle="xs" color="fg.muted">Не разложено по блюдам (заготовки, округления): {money(loose.costKop)}</Text>
              ) : <span />}
              {dishes.length > 15 && (
                <Button size="xs" variant="ghost" onClick={() => setAllDishes((v) => !v)}>
                  {allDishes ? "Свернуть" : `Все ${dishes.length}`}
                </Button>
              )}
            </Flex>
          </>
        )}
      </Section>
    </Box>
  );
}
