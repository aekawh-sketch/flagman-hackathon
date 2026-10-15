import { useNavigate } from "react-router";
import { Badge, Box, Button, Flex, Grid, HStack, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { LuShieldCheck, LuShieldX } from "react-icons/lu";
import { api } from "../api";
import { useServerNow, useSession } from "../session";
import { hoursBetween, money, time } from "../format";
import { Countdown, Empty, Kpi, Loading, PageHeader, Section, StatusBadge } from "../components/ui";
import { LossChart } from "../components/LossChart";
import { PeriodPicker, periodDays, periodLabel, usePeriod, useServerToday, weekEnding } from "../components/PeriodPicker";

export function DashboardPage() {
  const { loc } = useSession();
  const navigate = useNavigate();
  const now = useServerNow();
  // Период — для потерь, заказов, выручки и отказов; остатки, сроки и стоп-лист — всегда на сейчас.
  const [period, setPeriod] = usePeriod(1);
  const today = useServerToday();
  const label = periodLabel(period, today);
  // Один день — на графике неделя по этот день, иначе в нём один столбик.
  const chart = periodDays(period) === 1 ? weekEnding(period) : period;
  const dash = useQuery({ queryKey: ["dashboard", loc, period.from, period.to],
    queryFn: () => api.dashboard(loc, period.from, period.to), refetchInterval: 15_000 });
  const batches = useQuery({ queryKey: ["batches", loc], queryFn: () => api.batches(loc) });
  const hot = useQuery({ queryKey: ["hot", loc], queryFn: () => api.hot(loc) });
  const menu = useQuery({ queryKey: ["menu", loc], queryFn: () => api.menu(loc) });
  const losses = useQuery({ queryKey: ["writeoff-analytics", loc, chart.from, chart.to],
    queryFn: () => api.writeoffAnalytics(loc, periodDays(chart), chart.from, chart.to) });
  const forecast = useQuery({ queryKey: ["stop-forecast", loc], queryFn: () => api.stopForecast(loc, 12) });

  const k = dash.data?.kpis;
  const integrity = dash.data?.integrity;
  const risky = (batches.data ?? []).filter((b) => !b.blocked && (b.status === "CRITICAL" || b.status === "SOON"))
    .slice(0, 8);
  const stopByProduct = new Map<string, string[]>();
  (menu.data ?? []).filter((v) => v.inStop).forEach((v) => {
    const key = v.limitingProductName ?? "—";
    stopByProduct.set(key, [...(stopByProduct.get(key) ?? []), v.name]);
  });

  return (
    <>
      <PageHeader title="Дашборд"
        subtitle="Склад, сроки и стоп-лист — на сейчас; потери, заказы и отказы — за выбранный период"
        actions={
          <Flex gap="3" align="center" wrap="wrap" justify="flex-end">
            <PeriodPicker value={period} onChange={setPeriod} />
            {integrity && (
              <HStack px="3" py="1.5" rounded="md" borderWidth="1px" cursor="pointer" onClick={() => navigate(`/${loc}/ledger`)}
                      borderColor={integrity.ok ? "green.muted" : "red.muted"} bg={integrity.ok ? "green.subtle" : "red.subtle"}>
                {integrity.ok ? <LuShieldCheck color="var(--chakra-colors-green-fg)" /> : <LuShieldX color="var(--chakra-colors-red-fg)" />}
                <Text textStyle="sm" fontWeight="medium" color={integrity.ok ? "green.fg" : "red.fg"}>
                  {integrity.ok ? `Журнал цел · ${integrity.checked} записей` : `Журнал нарушен на записи №${integrity.brokenAtSeq}`}
                </Text>
              </HStack>
            )}
          </Flex>
        } />

      {!k ? <Loading rows={2} /> : (
        <SimpleGrid columns={{ base: 2, md: 3, xl: 6 }} gap="3" mb="5">
          <Kpi label="Склад" value={money(k.stockValueKop)} hint="по цене закупки" />
          <Kpi label="Скоро истекает" value={k.soonBatches + k.criticalBatches}
               hint={`из них критично: ${k.criticalBatches}`} palette={k.criticalBatches ? "orange" : undefined}
               onClick={() => navigate(`/${loc}/stock`)} />
          <Kpi label="В стопе" value={k.inStop} hint={`осталось мало: ${k.low}`}
               palette={k.inStop ? "red" : undefined} onClick={() => navigate(`/${loc}/menu`)} />
          <Kpi label={`Потери ${label}`} value={money(k.lossesTodayKop)} palette={k.lossesTodayKop ? "red" : undefined}
               onClick={() => navigate(`/${loc}/analytics`)} />
          <Kpi label={`Заказы ${label}`} value={k.ordersToday} hint={`выручка ${money(k.revenueTodayKop)}`} />
          <Kpi label={`Отказы ${label}`} value={k.refusalsToday} hint="не хватило продуктов"
               palette={k.refusalsToday ? "orange" : undefined} />
        </SimpleGrid>
      )}

      {k && (k.pendingWriteoffs > 0 || k.pendingDeliveries > 0 || k.approvedDeliveries > 0 || k.expiredBatches > 0) && (
        <HStack mb="5" gap="3" wrap="wrap">
          {k.expiredBatches > 0 && (
            <Button size="sm" colorPalette="red" variant="solid" onClick={() => navigate(`/${loc}/writeoffs`)}>
              Просрочка ждёт списания: {k.expiredBatches} на {money(k.expiredKop)}
            </Button>
          )}
          {k.pendingWriteoffs > 0 && (
            <Button size="sm" colorPalette="orange" variant="subtle" onClick={() => navigate(`/${loc}/writeoffs`)}>
              Заявок на списание ждут подписи: {k.pendingWriteoffs}
            </Button>
          )}
          {k.pendingDeliveries > 0 && (
            <Button size="sm" colorPalette="purple" variant="subtle" onClick={() => navigate(`/${loc}/acceptance`)}>
              Поставок ждут одобрения: {k.pendingDeliveries}
            </Button>
          )}
          {k.approvedDeliveries > 0 && (
            <Button size="sm" colorPalette="blue" variant="subtle" onClick={() => navigate(`/${loc}/acceptance`)}>
              Одобрены, ждут приёмки: {k.approvedDeliveries}
            </Button>
          )}
        </HStack>
      )}

      <Grid templateColumns={{ base: "1fr", xl: "1.2fr 1fr" }} gap="4">
        <Section title="Горячие предложения" actions={
          <Button size="xs" variant="ghost" onClick={() => navigate(`/${loc}/hot`)}>Все</Button>}>
          {hot.isLoading ? <Loading /> : hot.data?.error ? (
            <Text color="orange.fg" textStyle="sm">{hot.data.error}</Text>
          ) : !hot.data?.offers.length ? (
            <Empty title="Продвигать нечего" description="При текущих продажах ничего не пропадёт" />
          ) : (
            <Stack gap="3">
              {hot.data.offers.map((o) => (
                <Flex key={o.variantId} gap="3" align="start">
                  <Badge colorPalette="orange" variant="solid" rounded="full" minW="6" justifyContent="center">{o.rank}</Badge>
                  <Box flex="1" minW="0">
                    <HStack justify="space-between">
                      <Text fontWeight="semibold">{o.name}</Text>
                      <Text textStyle="sm" color="red.fg" whiteSpace="nowrap">спасёт до {money(o.lossKop)}</Text>
                    </HStack>
                    <Text textStyle="sm" color="fg.muted">{o.explanation}</Text>
                  </Box>
                </Flex>
              ))}
            </Stack>
          )}
        </Section>

        <Section title="Партии: скоро истекает" actions={
          <Button size="xs" variant="ghost" onClick={() => navigate(`/${loc}/stock`)}>Склад</Button>}>
          {batches.isLoading ? <Loading /> : risky.length === 0 ? (
            <Empty title="Всё свежее" />
          ) : (
            <Stack gap="2">
              {risky.map((b) => (
                <Flex key={b.id} justify="space-between" align="center" gap="3" cursor="pointer"
                      onClick={() => navigate(`/${loc}/batches/${b.id}`)}>
                  <Box minW="0">
                    <Text fontWeight="medium" lineClamp={2}>{b.productName}</Text>
                    <Text textStyle="xs" color="fg.muted">партия {b.label} · {b.qtyText}</Text>
                  </Box>
                  <HStack flexShrink={0}>
                    <Box hideBelow="sm"><StatusBadge status={b.status} /></Box>
                    <Countdown hours={hoursBetween(now, b.expiresAt)} status={b.status} />
                  </HStack>
                </Flex>
              ))}
            </Stack>
          )}
        </Section>

        <Section title="Стоп-лист" actions={
          <Button size="xs" variant="ghost" onClick={() => navigate(`/${loc}/menu`)}>Меню</Button>}>
          {stopByProduct.size === 0 ? <Empty title="Всё в продаже" /> : (
            <Stack gap="3">
              {[...stopByProduct.entries()].map(([product, dishes]) => (
                <Box key={product}>
                  <Text fontWeight="medium">Закончилось: {product} <Badge colorPalette="red">{dishes.length}</Badge></Text>
                  <Text textStyle="sm" color="fg.muted" lineClamp={2}>{dishes.join(", ")}</Text>
                </Box>
              ))}
            </Stack>
          )}
          {!!forecast.data?.length && (
            <Box mt="4" pt="3" borderTopWidth="1px">
              <Text textStyle="sm" fontWeight="semibold" mb="2">Прогноз на 12 часов</Text>
              <Stack gap="1">
                {forecast.data.slice(0, 5).map((f) => (
                  <Text key={f.variantId} textStyle="sm">
                    <b>{time(f.at)}</b> — {f.variantName}: {f.text}
                  </Text>
                ))}
              </Stack>
            </Box>
          )}
        </Section>

        <Section title={`Потери ${periodLabel(chart, today)}`} actions={
          losses.data && <Text textStyle="sm" color="fg.muted">{money(losses.data.totalKop)} · {(losses.data.lossShare * 100).toFixed(1)}% закупок</Text>}>
          {losses.data ? (
            <LossChart byDay={losses.data.byDay} />
          ) : <Loading />}
        </Section>
      </Grid>
    </>
  );
}
