import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Badge, Box, Button, Collapsible, Flex, Grid, HStack, Input, Stack, Table, Tabs, Text,
} from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { LuChevronDown, LuChevronRight, LuCookingPot, LuReceipt, LuSearch, LuWheat } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, glue, money, ORDER_STATUS, SOURCE, time } from "../format";
import type { DishUse, IngredientPart, IngredientTake, OrderTraceRow, PrepTrace } from "../types";
import { Empty, Kpi, Loading, PageHeader, Section } from "../components/ui";
import { PeriodPicker, periodDays, usePeriod, type Period } from "../components/PeriodPicker";
import { SearchSelect } from "../components/SearchSelect";

/** Период вкладок: календарные дни «с … по …» включительно. */
type Tp = { period: Period; days: number };

/**
 * Прослеживаемость (ТЗ 16.6): какие продукты и из каких партий ушли в каждое блюдо и заказ, из чего
 * сделаны заготовки. Всё считается по журналу движений и версиям техкарт — сходится до грамма.
 */
export function TracePage() {
  const [tab, setTab] = useState("orders");
  // Один период на все вкладки: заказы, заготовки и продукт — за одни и те же дни.
  const [period, setPeriod] = usePeriod(7);
  const p: Tp = { period, days: periodDays(period) };
  // Ссылка на конкретный заказ (из аналитики, «Подозрительного», карточки продукта): ?order=ID — он сразу сверху.
  const [params, setParams] = useSearchParams();
  const focus = Number(params.get("order")) || null;
  return (
    <>
      <PageHeader title="Прослеживаемость"
        subtitle="Что ушло в каждое блюдо и заказ — до партии, из чего сделана каждая заготовка. Считается по журналу движений, поэтому сходится с остатками до грамма."
        actions={<PeriodPicker value={period} onChange={setPeriod} />} />
      {focus && (
        <Box mb="4">
          <Section title="Заказ по ссылке" actions={
            <Button size="xs" variant="ghost" onClick={() => setParams({}, { replace: true })}>Скрыть</Button>}>
            <OrderComposition id={focus} withHeader />
          </Section>
        </Box>
      )}
      <Tabs.Root value={tab} onValueChange={(e) => setTab(e.value)} variant="line" lazyMount>
        <Tabs.List mb="4" overflowX="auto" css={{ scrollbarWidth: "none" }}>
          <Tabs.Trigger value="orders" flexShrink={0}><LuReceipt /> Заказы</Tabs.Trigger>
          <Tabs.Trigger value="preps" flexShrink={0}><LuCookingPot /> Заготовки</Tabs.Trigger>
          <Tabs.Trigger value="product" flexShrink={0}><LuWheat /> По продукту</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="orders" pt="0"><OrdersTab {...p} /></Tabs.Content>
        <Tabs.Content value="preps" pt="0"><PrepsTab {...p} /></Tabs.Content>
        <Tabs.Content value="product" pt="0"><ProductTab {...p} /></Tabs.Content>
      </Tabs.Root>
    </>
  );
}

// ── Заказы ──────────────────────────────────────────────────────────────────

function OrdersTab({ period, days }: Tp) {
  const { loc } = useSession();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["trace-orders", loc, period.from, period.to, search.trim()],
    queryFn: () => api.traceOrders(loc, days, search.trim() || undefined, period.from, period.to),
  });
  return (
    <Section title="Заказы">
      <HStack mb="3" maxW={{ md: "sm" }}>
        <Box position="relative" flex="1">
          <Box position="absolute" left="3" top="50%" transform="translateY(-50%)" color="fg.muted" pointerEvents="none">
            <LuSearch />
          </Box>
          <Input ps="9" placeholder="Номер заказа или блюдо" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Box>
      </HStack>
      {q.isLoading ? <Loading rows={6} /> : !q.data?.length ? (
        <Empty title="Заказов нет" description={search ? "Попробуйте другой номер или название" : "За этот период заказов не было"} />
      ) : (
        <Stack gap="2">
          {q.data.map((o) => (
            <OrderRow key={o.id} o={o} open={open === o.id} onToggle={() => setOpen(open === o.id ? null : o.id)} />
          ))}
        </Stack>
      )}
    </Section>
  );
}

function OrderRow({ o, open, onToggle }: { o: OrderTraceRow; open: boolean; onToggle: () => void }) {
  const st = ORDER_STATUS[o.status];
  return (
    <Box borderWidth="1px" rounded="md" bg={open ? "bg.subtle" : undefined}>
      <Flex as="button" w="full" textAlign="start" p="3" gap="3" align="center" onClick={onToggle}
            _hover={{ bg: "bg.muted" }} rounded="md" aria-expanded={open}>
        <Box color="fg.muted" flexShrink={0}>{open ? <LuChevronDown /> : <LuChevronRight />}</Box>
        <Box flex="1" minW="0">
          <HStack gap="2" wrap="wrap" rowGap="1">
            <Text fontWeight="semibold" whiteSpace="nowrap">№{o.number}</Text>
            <Text color="fg.muted" textStyle="sm" whiteSpace="nowrap">{dateTime(o.at)}</Text>
            <Badge size="sm" colorPalette={st?.palette}>{st?.label ?? o.status}</Badge>
            <Text color="fg.muted" textStyle="xs" hideBelow="sm">{SOURCE[o.source] ?? o.source}</Text>
          </HStack>
          <Text textStyle="sm" color="fg.muted" lineClamp={2}>{glue(o.dishes.join(", "))}</Text>
        </Box>
        <Box textAlign="end" flexShrink={0}>
          <Text textStyle="sm" fontWeight="medium" whiteSpace="nowrap">{money(o.costKop)}</Text>
          <Text textStyle="xs" color="fg.muted" whiteSpace="nowrap">из {money(o.totalKop)}</Text>
        </Box>
      </Flex>
      {open && <Box px="3" pb="3"><OrderComposition id={o.id} /></Box>}
    </Box>
  );
}

function OrderComposition({ id, withHeader }: { id: number; withHeader?: boolean }) {
  const { loc } = useSession();
  const q = useQuery({ queryKey: ["trace-order", loc, id], queryFn: () => api.traceOrder(loc, id) });
  if (q.isLoading) return <Loading rows={3} />;
  if (!q.data) return <Text color="fg.muted" textStyle="sm">Не удалось загрузить состав</Text>;
  const t = q.data;
  return (
    <Stack gap="3">
      {withHeader && (
        <HStack gap="2" wrap="wrap">
          <Text fontWeight="semibold">Заказ №{t.number}</Text>
          <Text color="fg.muted" textStyle="sm">{dateTime(t.at)}</Text>
          <Badge size="sm" colorPalette={ORDER_STATUS[t.status]?.palette}>{ORDER_STATUS[t.status]?.label ?? t.status}</Badge>
          <Text color="fg.muted" textStyle="sm">{money(t.costKop)} из {money(t.totalKop)}</Text>
        </HStack>
      )}
      {t.status === "CANCELED" && (
        <Text textStyle="sm" color="fg.muted">Отменён до готовки: всё взятое вернули в те же партии.</Text>
      )}
      {t.status === "CANCELED_LATE" && (
        <Text textStyle="sm" color="orange.fg">Отменён после начала готовки: продукты ушли в потери.</Text>
      )}
      {t.dishes.map((d) => (
        <Box key={d.lineNo} borderWidth="1px" rounded="md" bg="bg.panel" p="3">
          <Flex justify="space-between" gap="3" mb="2" wrap="wrap" rowGap="1">
            <HStack gap="2" wrap="wrap" rowGap="1">
              <Text fontWeight="semibold">{glue(`${d.name} ×${d.qty}`)}</Text>
              {d.recipeVersion != null && <Badge size="sm" variant="outline">техкарта v{d.recipeVersion}</Badge>}
            </HStack>
            <Text textStyle="sm" color="fg.muted" whiteSpace="nowrap">себестоимость {money(d.costKop)}</Text>
          </Flex>
          {d.parts.length ? <Parts parts={d.parts} /> : <Text textStyle="sm" color="fg.muted">Блюдо без техкарты — склад его не списывает</Text>}
        </Box>
      ))}
      {t.unassigned.length > 0 && (
        <Box borderWidth="1px" borderStyle="dashed" rounded="md" p="3">
          <Text fontWeight="semibold" mb="2">Не отнесено к блюду</Text>
          <Parts parts={t.unassigned} />
        </Box>
      )}
      <Text textStyle="xs" color="fg.muted">
        Пробил(а): {t.createdBy ?? "—"} · себестоимость заказа {money(t.costKop)} — ровно сумма блюд выше
      </Text>
    </Stack>
  );
}

// ── Составные части ─────────────────────────────────────────────────────────

/** Продукты состава: сколько, из каких партий; заготовку можно раскрыть до сырья. */
function Parts({ parts, nested }: { parts: IngredientPart[]; nested?: boolean }) {
  return (
    <Stack gap="0" borderTopWidth={nested ? undefined : "1px"}>
      {parts.map((p) => <PartRow key={p.productId} p={p} nested={nested} />)}
    </Stack>
  );
}

function PartRow({ p, nested }: { p: IngredientPart; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const madeFrom = p.batches.flatMap((b) => b.madeFrom);
  return (
    <Box py="1.5" borderBottomWidth={nested ? undefined : "1px"}>
      <Flex gap="3" align="start">
        <Box flex="1" minW="0">
          <HStack gap="1.5" wrap="wrap" rowGap="0.5">
            <Text textStyle="sm" fontWeight={nested ? "normal" : "medium"}>{p.productName}</Text>
            {p.semi && <Badge size="xs" colorPalette="purple">заготовка</Badge>}
          </HStack>
          <HStack gap="1" mt="1" wrap="wrap">
            {p.batches.map((b, i) => <BatchChip key={`${b.batchId}-${i}`} b={b} />)}
          </HStack>
          {madeFrom.length > 0 && (
            <Collapsible.Root open={open} onOpenChange={(e) => setOpen(e.open)}>
              <Collapsible.Trigger asChild>
                <Button size="2xs" variant="ghost" colorPalette="purple" mt="1" px="1">
                  {open ? <LuChevronDown /> : <LuChevronRight />} из чего сделана
                </Button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <Box ms="3" ps="3" borderStartWidth="2px" borderColor="purple.muted" mt="1">
                  {p.batches.filter((b) => b.madeFrom.length).map((b) => (
                    <Box key={b.batchId} mb="1">
                      {p.batches.length > 1 && <Text textStyle="xs" color="fg.muted">из партии {b.label}, {b.qtyText}:</Text>}
                      <Parts parts={b.madeFrom} nested />
                    </Box>
                  ))}
                </Box>
              </Collapsible.Content>
            </Collapsible.Root>
          )}
        </Box>
        <Box textAlign="end" flexShrink={0}>
          <Text textStyle="sm" fontWeight="medium" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
            {nested ? "≈ " : ""}{p.qtyText}
          </Text>
          <Text textStyle="xs" color="fg.muted" whiteSpace="nowrap">{money(p.costKop)}</Text>
        </Box>
      </Flex>
    </Box>
  );
}

function origin(b: IngredientTake) {
  if (b.source === "PRODUCTION") return `заготовка${b.producedAt ? ` от ${dateTime(b.producedAt)}` : ""}`;
  const from = b.deliveryNumber ? `поставка ${b.deliveryNumber}${b.supplier ? ` · ${b.supplier}` : ""}` : "";
  if (b.source === "OPENING") return `вскрытая упаковка ${b.parentLabel ?? ""}${from ? ` · ${from}` : ""}`;
  if (b.source === "SURPLUS") return "излишек инвентаризации";
  return from;
}

function BatchChip({ b }: { b: IngredientTake }) {
  const { loc } = useSession();
  const navigate = useNavigate();
  return (
    <Button size="2xs" variant="surface" colorPalette={b.source === "PRODUCTION" ? "purple" : "gray"}
            title={`${origin(b)} — открыть партию`} onClick={() => navigate(`/${loc}/batches/${b.batchId}`)}
            fontWeight="normal" maxW="full">
      <Text as="span" fontFamily="mono" fontWeight="semibold">{b.label}</Text>
      <Text as="span" fontVariantNumeric="tabular-nums">{b.qtyText}</Text>
    </Button>
  );
}

// ── Заготовки ───────────────────────────────────────────────────────────────

function PrepsTab({ period, days }: Tp) {
  const { loc } = useSession();
  const q = useQuery({ queryKey: ["trace-preps", loc, period.from, period.to],
    queryFn: () => api.tracePreps(loc, days, period.from, period.to) });
  return (
    <Section title="Приготовленные заготовки">
      <Text textStyle="sm" color="fg.muted" mb="3">
        Соусы, тесто, рис и другие заготовки: из каких партий сырья их сделали и в какие блюда они ушли.
      </Text>
      {q.isLoading ? <Loading rows={5} /> : !q.data?.length ? (
        <Empty title="Заготовок не готовили" description="Заготовки готовит повар на экране «Кухня»" />
      ) : (
        <Grid templateColumns={{ base: "1fr", xl: "1fr 1fr" }} gap="3">
          {q.data.map((p) => <PrepCard key={p.batchId} p={p} />)}
        </Grid>
      )}
    </Section>
  );
}

function PrepCard({ p }: { p: PrepTrace }) {
  const { loc } = useSession();
  const navigate = useNavigate();
  const [dishes, setDishes] = useState(false);
  const used = p.qty ? Math.min(1, p.toOrders / p.qty) : 0;
  return (
    <Box borderWidth="1px" rounded="md" p="3" bg="bg.panel">
      <Flex justify="space-between" gap="3" wrap="wrap" rowGap="1">
        <Box minW="0">
          <HStack gap="2" wrap="wrap" rowGap="0.5">
            <Text fontWeight="semibold">{p.productName}</Text>
            <Button size="2xs" variant="surface" colorPalette="purple" fontFamily="mono"
                    onClick={() => navigate(`/${loc}/batches/${p.batchId}`)}>{p.label}</Button>
          </HStack>
          <Text textStyle="xs" color="fg.muted">{dateTime(p.at)} · {p.cook} · годна до {dateTime(p.expiresAt)}</Text>
        </Box>
        <Box textAlign="end">
          <Text fontWeight="semibold" whiteSpace="nowrap">{p.qtyText}</Text>
          <Text textStyle="xs" color="fg.muted" whiteSpace="nowrap">{money(p.costKop)}</Text>
        </Box>
      </Flex>

      <Box mt="2" h="1.5" rounded="full" bg="bg.muted" overflow="hidden" title="Сколько ушло в заказы">
        <Box h="full" w={`${Math.round(used * 100)}%`} bg="teal.solid" />
      </Box>
      <HStack gap="3" mt="1" textStyle="xs" color="fg.muted" wrap="wrap" rowGap="0">
        <Text>в заказы <b>{p.toOrdersText}</b>{p.orders ? ` (${p.orders})` : ""}</Text>
        {p.lost > 0 && <Text color="red.fg">списано {p.lostText}</Text>}
        <Text>осталось {p.leftText}</Text>
      </HStack>

      <Text textStyle="xs" fontWeight="semibold" color="fg.muted" mt="3" mb="1" textTransform="uppercase" letterSpacing="0.04em">
        Из чего сделана
      </Text>
      <Parts parts={p.parts} />

      {p.orders > 0 && (
        <Box mt="2">
          <Button size="xs" variant="ghost" px="1" onClick={() => setDishes(!dishes)}>
            {dishes ? <LuChevronDown /> : <LuChevronRight />} В какие блюда ушла
          </Button>
          {dishes && <BatchDishes batchId={p.batchId} />}
        </Box>
      )}
    </Box>
  );
}

/** В какие блюда ушла партия — используется и на карточке партии. */
export function BatchDishes({ batchId }: { batchId: number }) {
  const { loc } = useSession();
  const q = useQuery({ queryKey: ["trace-batch-dishes", loc, batchId], queryFn: () => api.traceBatchDishes(loc, batchId) });
  if (q.isLoading) return <Loading rows={2} />;
  if (!q.data?.length) return <Text textStyle="sm" color="fg.muted">В блюда пока не уходила</Text>;
  return <DishTable rows={q.data} />;
}

export function DishTable({ rows, showVia }: { rows: DishUse[]; showVia?: boolean }) {
  return (
    <Table.Root size="sm">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Блюдо</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end" hideBelow="sm">Порций</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end" hideBelow="md">Заказов</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Ушло</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end" hideBelow="sm">₽</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((d) => (
          <Table.Row key={`${d.variantId}|${d.via}`}>
            <Table.Cell>
              <Text textStyle="sm">{d.name}</Text>
              {showVia && d.via && <Badge size="xs" colorPalette="purple" mt="0.5">через «{d.via}»</Badge>}
              <Text hideFrom="sm" textStyle="xs" color="fg.muted">{d.portions} порц. · {money(d.costKop)}</Text>
            </Table.Cell>
            <Table.Cell textAlign="end" hideBelow="sm" fontVariantNumeric="tabular-nums">{d.portions}</Table.Cell>
            <Table.Cell textAlign="end" hideBelow="md" fontVariantNumeric="tabular-nums">{d.orders}</Table.Cell>
            <Table.Cell textAlign="end" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
              {d.via ? "≈ " : ""}{d.qtyText}
            </Table.Cell>
            <Table.Cell textAlign="end" hideBelow="sm" whiteSpace="nowrap">{money(d.costKop)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

// ── По продукту ─────────────────────────────────────────────────────────────

function ProductTab({ period, days }: Tp) {
  const { loc } = useSession();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const products = useMemo(() => [...(catalog.data?.products ?? [])]
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "ru") : a.kind === "RAW" ? -1 : 1)), [catalog.data]);
  const [productId, setProductId] = useState("");
  const pid = productId || products[0]?.id || "";
  const q = useQuery({
    queryKey: ["trace-product", loc, pid, period.from, period.to], enabled: !!pid,
    queryFn: () => api.traceProduct(loc, pid, days, period.from, period.to),
  });
  const t = q.data;
  return (
    <Stack gap="4">
      <Flex gap="3" wrap="wrap" align="center">
        {/* Поиск по продукту: на телефоне длинный список неудобен — печатаете «лос» и выбираете. */}
        <Box w={{ base: "full", sm: "sm" }}>
          <SearchSelect value={pid} onChange={setProductId} placeholder="Найти продукт: «лосось», «соус»…"
                        options={products.map((p) => ({ value: p.id, label: p.name, group: p.kind === "SEMI" ? "Заготовки" : "Сырьё",
                          hint: p.kind === "SEMI" ? "заготовка" : p.category ?? undefined }))} />
        </Box>
      </Flex>

      {q.isLoading || catalog.isLoading ? <Loading rows={5} /> : !t ? null : (
        <>
          <Grid templateColumns={{ base: "1fr 1fr", md: "repeat(3, 1fr)" }} gap="3">
            <Kpi label="В блюда" value={t.toDishesText} hint="напрямую и через заготовки" />
            {!t.semi && <Kpi label="В заготовки" value={t.toPrepsText} hint={`${t.preps.length} раз готовили`} />}
            <Kpi label="Списано" value={t.lostText} palette={t.lost > 0 ? "red" : undefined} hint="просрочка, порча, отзыв" />
          </Grid>

          <Section title={`«${t.productName}» по блюдам`}>
            {t.dishes.length ? <DishTable rows={t.dishes} showVia /> : <Empty title="За период в блюда не уходил" />}
            {t.dishes.some((d) => d.via) && (
              <Text textStyle="xs" color="fg.muted" mt="2">
                ≈ — через заготовку: доля продукта в ней × сколько заготовки взяли в блюдо.
              </Text>
            )}
          </Section>

          <Grid templateColumns={{ base: "1fr", xl: "1fr 1fr" }} gap="4">
            {!t.semi && (
              <Section title="В какие заготовки">
                {!t.preps.length ? <Text textStyle="sm" color="fg.muted">Из него ничего не готовили</Text> : (
                  <Stack gap="1">
                    {t.preps.map((p) => (
                      <Flex key={p.batchId} justify="space-between" gap="3" textStyle="sm">
                        <Text minW="0" truncate>
                          {p.productName} <Text as="span" fontFamily="mono" color="fg.muted">{p.label}</Text>
                        </Text>
                        <HStack gap="3" flexShrink={0}>
                          <Text color="fg.muted" hideBelow="sm">{dateTime(p.at)}</Text>
                          <Text fontWeight="medium" whiteSpace="nowrap">{p.qtyText}</Text>
                        </HStack>
                      </Flex>
                    ))}
                  </Stack>
                )}
              </Section>
            )}
            <Section title="Последние заказы с ним">
              {!t.orders.length ? <Text textStyle="sm" color="fg.muted">Заказов не было</Text> : (
                <Stack gap="1">
                  {t.orders.map((o, i) => (
                    <Flex key={`${o.orderId}-${i}`} justify="space-between" gap="3" textStyle="sm">
                      <Text minW="0" truncate>
                        <Text as="span" fontWeight="medium">№{o.number}</Text>{" "}
                        <Text as="span" color="fg.muted">{time(o.at)}</Text> · {glue(o.dish)}
                        {o.via && <Text as="span" color="purple.fg"> · через «{o.via}»</Text>}
                      </Text>
                      <Text whiteSpace="nowrap" fontVariantNumeric="tabular-nums">{o.via ? "≈ " : ""}{o.qtyText}</Text>
                    </Flex>
                  ))}
                </Stack>
              )}
            </Section>
          </Grid>
        </>
      )}
    </Stack>
  );
}
