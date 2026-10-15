import { Fragment, useMemo, useState } from "react";
import { Badge, Box, Grid, HStack, Input, Stack, Table, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../session";
import { glue, money, time } from "../format";
import { Empty, Loading, PageHeader, Section, Segments } from "../components/ui";

export function MenuPage() {
  const { loc } = useSession();
  const menu = useQuery({ queryKey: ["menu", loc], queryFn: () => api.menu(loc) });
  const forecast = useQuery({ queryKey: ["stop-forecast", loc, 48], queryFn: () => api.stopForecast(loc, 48) });
  const [filter, setFilter] = useState("problems");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => (menu.data ?? [])
    .filter((v) => filter === "all" || (filter === "stop" ? v.inStop : v.inStop || v.low))
    .filter((v) => !search || v.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.inStop) - Number(a.inStop) || a.portions - b.portions), [menu.data, filter, search]);
  const inStop = (menu.data ?? []).filter((v) => v.inStop).length;
  const low = (menu.data ?? []).filter((v) => v.low).length;

  return (
    <>
      <PageHeader title="Меню и стоп-лист"
        subtitle="Доступные порции = минимум по продуктам техкарты ⌊доступно / брутто⌋. Считается для каждого блюда отдельно — блюда делят общие продукты, поэтому это верхняя граница." />
      <Grid templateColumns={{ base: "1fr", xl: "1.5fr 1fr" }} gap="4" alignItems="start">
        <Section title={<HStack wrap="wrap">Блюда <Badge colorPalette="red">в стопе {inStop}</Badge><Badge colorPalette="orange">мало {low}</Badge></HStack>}
          actions={
            <Segments value={filter} onChange={setFilter} items={[{ value: "problems", label: "Проблемные" },
              { value: "stop", label: "Стоп" }, { value: "all", label: "Все" }]} />}>
          <Input size="sm" mb="3" placeholder="Поиск блюда" value={search} onChange={(e) => setSearch(e.target.value)} />
          {menu.isLoading ? <Loading rows={8} /> : rows.length === 0 ? <Empty title="Всё в продаже" /> : (
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Блюдо</Table.ColumnHeader>
                  <Table.ColumnHeader>Порций</Table.ColumnHeader>
                  <Table.ColumnHeader hideBelow="md">Ограничивает</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Цена</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((v) => {
                  const limit = (v.limitingProductName || v.hint) && (
                    <>
                      {v.limitingProductName}
                      {v.hint && <Text textStyle="xs" color="teal.fg">{v.hint}</Text>}
                    </>
                  );
                  return (
                    <Fragment key={v.variantId}>
                      <Table.Row>
                        <Table.Cell borderBottomWidth={limit ? { base: "0", md: "1px" } : undefined}>
                          <Text fontWeight="medium">{glue(v.name)}</Text>
                          <Text textStyle="xs" color="fg.muted">{v.category}{v.isSet ? " · сет" : ""}</Text>
                        </Table.Cell>
                        <Table.Cell borderBottomWidth={limit ? { base: "0", md: "1px" } : undefined} whiteSpace="nowrap">
                          {!v.tracked ? <Text color="fg.subtle" whiteSpace="normal">без техкарты</Text>
                            : v.inStop ? <Badge colorPalette="red">стоп</Badge>
                              : v.low ? <Badge colorPalette="orange">осталось {v.portions}</Badge>
                                : <Text>{v.portions > 999 ? "999+" : v.portions}</Text>}
                        </Table.Cell>
                        <Table.Cell hideBelow="md" textStyle="sm">{limit}</Table.Cell>
                        <Table.Cell borderBottomWidth={limit ? { base: "0", md: "1px" } : undefined} textAlign="end" whiteSpace="nowrap">
                          {money(v.priceKop)}
                        </Table.Cell>
                      </Table.Row>
                      {/* На телефоне «что ограничивает» — отдельной строкой во всю ширину, а не узкой колонкой. */}
                      {limit && (
                        <Table.Row hideFrom="md">
                          <Table.Cell colSpan={3} pt="0" textStyle="xs" color="fg.muted">Ограничивает: {limit}</Table.Cell>
                        </Table.Row>
                      )}
                    </Fragment>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
        </Section>

        <Section title="Прогноз стоп-листа на 48 часов">
          <Text textStyle="sm" color="fg.muted" mb="3">
            Проигрываем расход по FEFO и истечение партий по часам работы точки.
          </Text>
          {forecast.isLoading ? <Loading /> : !forecast.data?.length ? <Empty title="Стопов не ожидается" /> : (
            <Stack gap="2" maxH="70vh" overflowY="auto">
              {forecast.data.map((f) => (
                <HStack key={f.variantId} align="start" gap="3">
                  <Box minW="12"><Text fontWeight="bold" fontVariantNumeric="tabular-nums">{time(f.at)}</Text></Box>
                  <Box>
                    <Text textStyle="sm" fontWeight="medium">{f.variantName}</Text>
                    <HStack gap="1">
                      <Badge size="sm" colorPalette={f.cause === "EXPIRED" ? "red" : "orange"}>
                        {f.cause === "EXPIRED" ? "истечёт срок" : "закончится"}
                      </Badge>
                      <Text textStyle="xs" color="fg.muted">{f.productName}</Text>
                    </HStack>
                  </Box>
                </HStack>
              ))}
            </Stack>
          )}
        </Section>
      </Grid>
    </>
  );
}
