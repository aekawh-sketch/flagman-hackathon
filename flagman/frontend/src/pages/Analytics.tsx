import { useState } from "react";
import { useSearchParams } from "react-router";
import { PeriodPicker, periodDays, usePeriod } from "../components/PeriodPicker";
import { OperationsDrawer, ProductDrawer } from "../components/Drill";
import { LuChevronRight } from "react-icons/lu";
import { Box, Flex, Grid, HStack, SimpleGrid, Table, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { Cell, Pie, PieChart, ResponsiveContainer, Sector, Tooltip } from "recharts";
import { api } from "../api";
import { useSession } from "../session";
import { money, plural } from "../format";
import { Empty, Kpi, Loading, PageHeader, Section, Segments } from "../components/ui";
import { ProfitView } from "../components/ProfitView";
import { LossChart } from "../components/LossChart";
import { SupplyReport } from "../components/SupplyReport";

const COLORS = ["#dc2626", "#ea580c", "#d97706", "#7c3aed", "#0891b2", "#4b5563", "#be185d", "#16a34a"];

const MODES = [{ value: "losses", label: "Потери и дефицит" }, { value: "profit", label: "Прибыль" }];

/**
 * Аналитика (ТЗ 5.12, 16.18), два режима: «Потери и дефицит» — списания в рублях по причинам, продуктам и
 * сотрудникам, дефицитные ингредиенты; «Прибыль» — выручка, прибыль и «в плюсе» по дням и по блюдам.
 */
export function AnalyticsPage() {
  const { loc } = useSession();
  // Период «с … по …» — для всех блоков страницы; по умолчанию последние 7 дней.
  const [period, setPeriod] = usePeriod(7);
  const days = periodDays(period);
  // Режим — в адресе (?mode=profit): ссылку на «Прибыль» можно отправить, «Назад» возвращает режим
  const [params, setParams] = useSearchParams();
  const mode = params.get("mode") === "profit" ? "profit" : "losses";
  const setMode = (m: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (m === "profit") next.set("mode", "profit"); else next.delete("mode");
    return next;
  }, { replace: true });
  const losses = mode === "losses";
  const w = useQuery({ queryKey: ["writeoff-analytics", loc, period.from, period.to], enabled: losses,
    queryFn: () => api.writeoffAnalytics(loc, days, period.from, period.to) });
  const d = useQuery({ queryKey: ["deficit", loc, period.from, period.to], enabled: losses,
    queryFn: () => api.deficit(loc, days, period.from, period.to) });
  const who = useQuery({ queryKey: ["operations-actors", loc, period.from, period.to], enabled: losses,
    queryFn: () => api.operationsByActor(loc, { days, from: period.from, to: period.to }) });
  // Подробности: по клику на сотрудника, причину, продукт — что, откуда и куда, со ссылками на документы.
  const [drill, setDrill] = useState<
    { kind: "ops"; title: string; subtitle?: string; filter: { actor?: string; type?: string } } |
    { kind: "product"; id: string; name: string } | null>(null);
  const drillPeriod = { days, from: period.from, to: period.to };
  const clickable = { cursor: "pointer", _hover: { bg: "bg.muted" } } as const;
  const data = w.data;
  // Причина → её списания: и с сектора круга, и со строки легенды. Поздние отмены — заказы, а не операции списания.
  const canOpenReason = (key: string) => key !== "CANCELED_LATE";
  const openReason = (r: { key: string; name: string }) =>
    canOpenReason(r.key) && setDrill({ kind: "ops", title: `Списания: ${r.name}`, filter: { type: r.key } });

  return (
    <>
      <PageHeader title="Аналитика" subtitle={losses ? "Потери, дефицит, поставки и расход за выбранный период"
        : "Выручка, прибыль и что осталось «в плюсе» после потерь — за выбранный период"}
        actions={<PeriodPicker value={period} onChange={setPeriod} />} />
      <Box mb="4"><Segments value={mode} onChange={setMode} items={MODES} /></Box>
      {!losses ? <ProfitView loc={loc} days={days} from={period.from} to={period.to} /> : !data ? <Loading rows={4} /> : (
        <>
          <SimpleGrid columns={{ base: 2, md: 4 }} gap="3" mb="4">
            <Kpi label="Потери" value={money(data.totalKop)} palette="red" />
            <Kpi label="Закупки" value={money(data.purchasesKop)} />
            <Kpi label="Доля потерь" value={`${(data.lossShare * 100).toFixed(1)}%`} hint="от закупок за период" />
            <Kpi label="Главная причина" value={data.byReason[0]?.name ?? "—"} hint={data.byReason[0] ? money(data.byReason[0].valueKop) : undefined} />
          </SimpleGrid>
          <Grid templateColumns={{ base: "1fr", xl: "1fr 1fr" }} gap="4" mb="4">
            <Section title="Потери по дням">
              <LossChart byDay={data.byDay} height={240} fontSize={11} />
            </Section>
            <Section title="По причинам">
              {!data.byReason.length ? <Empty title="Потерь не было" /> : (
                <Flex direction={{ base: "column", sm: "row" }} align={{ base: "stretch", sm: "center" }} gap="4">
                  <Box h={{ base: "180px", sm: "220px" }} flex={{ base: "none", sm: "1" }}>
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={data.byReason.map((r) => ({ name: r.name, value: Math.round(r.valueKop / 100) }))}
                             dataKey="value" nameKey="name" innerRadius={50} outerRadius={90}
                             paddingAngle={data.byReason.length > 1 ? 3 : 0}
                             cornerRadius={data.byReason.length > 1 ? 4 : 0} stroke="none"
                             onClick={(_, i) => data.byReason[i] && openReason(data.byReason[i])}
                             activeShape={(p: object) => <Sector {...p} outerRadius={((p as { outerRadius: number }).outerRadius) + 6} />}>
                          {/* Сегменты разделены зазором; наведённый чуть выдвигается. Одна причина — сплошное кольцо:
                              скругление концов на 360° даёт зазубрину, поэтому без него. Клик — списания причины. */}
                          {data.byReason.map((r, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} cursor={canOpenReason(r.key) ? "pointer" : "default"} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v) => `${v} ₽`} />
                      </PieChart>
                    </ResponsiveContainer>
                  </Box>
                  <Box flex="1">
                    {data.byReason.map((r, i) => {
                      const can = canOpenReason(r.key);
                      return (
                        <HStack key={r.key} justify="space-between" textStyle="sm" py="1" px="1" rounded="sm"
                                {...(can ? clickable : {})} onClick={() => openReason(r)}>
                          <HStack><Box w="2.5" h="2.5" rounded="full" bg={COLORS[i % COLORS.length]} /><Text>{r.name}</Text></HStack>
                          <HStack gap="1"><Text fontWeight="medium" whiteSpace="nowrap">{money(r.valueKop)}</Text>
                            {can && <LuChevronRight color="var(--chakra-colors-fg-muted)" />}</HStack>
                        </HStack>
                      );
                    })}
                  </Box>
                </Flex>
              )}
            </Section>
          </Grid>
          <Grid templateColumns={{ base: "1fr", xl: "1fr 1fr" }} gap="4" mb="4">
            <Section title="Топ-10 продуктов по потерям">
              <Table.Root size="sm">
                <Table.Body>
                  {data.byProduct.map((p) => (
                    <Table.Row key={p.key} {...clickable} onClick={() => setDrill({ kind: "product", id: p.key, name: p.name })}>
                      <Table.Cell>{p.name}</Table.Cell>
                      <Table.Cell textAlign="end" color="fg.muted">{p.qtyText}</Table.Cell>
                      <Table.Cell textAlign="end" fontWeight="medium">{money(p.valueKop)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Section>
            <Section title="Списания по сотрудникам">
              <Table.Root size="sm">
                <Table.Body>
                  {data.byEmployee.map((p) => (
                    <Table.Row key={p.key} {...clickable}
                               onClick={() => setDrill({ kind: "ops", title: p.name, subtitle: "все операции сотрудника", filter: { actor: p.key } })}>
                      <Table.Cell>{p.name}</Table.Cell>
                      <Table.Cell textAlign="end" color="fg.muted">{p.count} операций</Table.Cell>
                      <Table.Cell textAlign="end" fontWeight="medium">{money(p.valueKop)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Section>
          </Grid>
        </>
      )}
      {/* Поставки, кто что делал и дефицит — только в режиме «Потери и дефицит» */}
      {losses && (<>
      <Box mb="4"><SupplyReport days={days} from={period.from} to={period.to} /></Box>
      <Box mb="4">
        <Section title="Кто что делал">
          <Text textStyle="sm" color="fg.muted" mb="3">
            Все операции сотрудников за период: заказы, приёмка, заготовки, списания. Нажмите — откроется список с датами и ссылками.
          </Text>
          {who.isLoading ? <Loading /> : !who.data?.length ? <Empty title="Операций не было" /> : (
            <Table.Root size="sm">
              <Table.Body>
                {who.data.map((a) => (
                  <Table.Row key={a.actor} {...clickable}
                             onClick={() => setDrill({ kind: "ops", title: a.name, subtitle: "все операции сотрудника", filter: { actor: a.actor } })}>
                    <Table.Cell>
                      <Text fontWeight="medium">{a.name}</Text>
                      <Text textStyle="xs" color="fg.muted" lineClamp={2}>
                        {a.types.slice(0, 4).map((t) => `${t.title.toLowerCase()} ${t.count}`).join(" · ")}
                      </Text>
                    </Table.Cell>
                    <Table.Cell textAlign="end" whiteSpace="nowrap" color="fg.muted">
                      {a.count} {plural(a.count, ["операция", "операции", "операций"])}
                    </Table.Cell>
                    <Table.Cell textAlign="end" w="8"><LuChevronRight color="var(--chakra-colors-fg-muted)" /></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Section>
      </Box>
      <Section title="Самые дефицитные ингредиенты">
        {d.isLoading ? <Loading /> : !d.data?.length ? <Empty title="Дефицита не было" /> : (
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Продукт</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Отказов</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md" textAlign="end">Раз в стопе</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md" textAlign="end">Часов в стопе</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Упущено<Box as="span" hideBelow="md"> выручки</Box></Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {d.data.slice(0, 15).map((r) => (
                <Table.Row key={r.productId} {...clickable} onClick={() => setDrill({ kind: "product", id: r.productId, name: r.productName })}>
                  <Table.Cell>
                    <Text fontWeight="medium">{r.productName}</Text>
                    <Text hideFrom="md" textStyle="xs" color="fg.muted">
                      в стопе {r.stopEvents} {plural(r.stopEvents, ["раз", "раза", "раз"])} · {r.stopHours.toFixed(1).replace(".", ",")}{"\u00A0"}ч
                    </Text>
                  </Table.Cell>
                  <Table.Cell textAlign="end">{r.refusals}</Table.Cell>
                  <Table.Cell hideBelow="md" textAlign="end">{r.stopEvents}</Table.Cell>
                  <Table.Cell hideBelow="md" textAlign="end">{r.stopHours.toFixed(1)}</Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap">{money(r.lostRevenueKop)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </Section>
      </>)}
      <OperationsDrawer open={drill?.kind === "ops"} onClose={() => setDrill(null)}
                        title={drill?.kind === "ops" ? drill.title : ""} subtitle={drill?.kind === "ops" ? drill.subtitle : undefined}
                        filter={drill?.kind === "ops" ? drill.filter : {}} period={drillPeriod} />
      <ProductDrawer open={drill?.kind === "product"} onClose={() => setDrill(null)}
                     productId={drill?.kind === "product" ? drill.id : null} name={drill?.kind === "product" ? drill.name : undefined}
                     period={drillPeriod} />
    </>
  );
}
