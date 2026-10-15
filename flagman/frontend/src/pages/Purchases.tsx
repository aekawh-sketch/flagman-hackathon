import { Fragment } from "react";
import { Badge, Box, Button, Grid, Table, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { LuDownload, LuPrinter } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { money, timeLeft } from "../format";
import { Empty, Loading, PageHeader, Section } from "../components/ui";
import { SupplyReport } from "../components/SupplyReport";
import { PeriodPicker, periodDays, usePeriod } from "../components/PeriodPicker";

/** Предложение поставок (ТЗ 5.9): хватить до следующей поставки и не закупить того, что испортится. */
export function PurchasesPage() {
  const { loc } = useSession();
  const data = useQuery({ queryKey: ["purchases", loc], queryFn: () => api.purchases(loc) });
  // Период — для отчёта «Поставлено — съедено — просрочено»; «Что заказать» — прогноз на ближайшие дни.
  const [period, setPeriod] = usePeriod(30);
  const toOrder = data.data?.toOrder ?? [];
  const total = toOrder.reduce((s, p) => s + p.estCostKop, 0);

  const csv = () => {
    const rows = [["Продукт", "Заказать", "Ед.", "Примерная сумма, ₽", "Объяснение"],
      ...toOrder.map((p) => [p.productName, String(p.orderQty), p.unit, String(Math.round(p.estCostKop / 100)), p.explanation])];
    const text = "﻿" + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = `zakaz-${loc}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <>
      <PageHeader title="Закупки" subtitle="Расход — средний за 7 дней (свежие дни весомее); учитываем, что истечёт до прихода поставки, и не берём больше, чем успеем продать до конца срока."
        actions={<>
          <Button size="sm" variant="outline" onClick={csv} disabled={!toOrder.length}><LuDownload /> CSV / 1С</Button>
          <Button size="sm" variant="outline" onClick={() => window.print()}><LuPrinter /> Печать</Button>
        </>} />
      {data.isLoading ? <Loading rows={8} /> : (
        <Grid templateColumns={{ base: "1fr", xl: "1.6fr 1fr" }} gap="4" alignItems="start">
          <Section title={`Что заказать · ≈ ${money(total)}`}>
            {toOrder.length === 0 ? <Empty title="Всего хватает" /> : (
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Продукт</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Заказать</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="end">Сумма</Table.ColumnHeader>
                    <Table.ColumnHeader hideBelow="md">Почему</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {toOrder.map((p) => {
                    const why = <>
                      {p.explanation}
                      {p.cappedByLife && <Badge ml="1" size="xs" colorPalette="purple">ограничено сроком</Badge>}
                    </>;
                    const joined = { base: "0", md: "1px" };
                    return (
                      <Fragment key={p.productId}>
                        <Table.Row>
                          <Table.Cell fontWeight="medium" borderBottomWidth={joined}>{p.productName}</Table.Cell>
                          <Table.Cell textAlign="end" fontWeight="semibold" whiteSpace="nowrap" borderBottomWidth={joined}>{p.orderText}</Table.Cell>
                          <Table.Cell textAlign="end" whiteSpace="nowrap" borderBottomWidth={joined}>{money(p.estCostKop)}</Table.Cell>
                          <Table.Cell hideBelow="md" textStyle="xs" color="fg.muted">{why}</Table.Cell>
                        </Table.Row>
                        {/* На телефоне объяснение — во всю ширину под строкой. */}
                        <Table.Row hideFrom="md">
                          <Table.Cell colSpan={3} pt="0" textStyle="xs" color="fg.muted">{why}</Table.Cell>
                        </Table.Row>
                      </Fragment>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            )}
          </Section>
          <Section title="Не заказывать: избыток пропадёт">
            {!data.data?.doNotOrder.length ? <Empty title="Избытка нет" /> : (
              <Table.Root size="sm">
                <Table.Body>
                  {data.data.doNotOrder.map((s) => (
                    <Table.Row key={s.productId}>
                      <Table.Cell>
                        <Text fontWeight="medium">{s.productName}</Text>
                        <Text textStyle="xs" color="fg.muted">пропадёт {s.atRiskText} через {timeLeft(s.hoursLeft)}</Text>
                      </Table.Cell>
                      <Table.Cell textAlign="end" color="red.fg" whiteSpace="nowrap">≈ {money(s.lossKop)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
            <Text textStyle="xs" color="fg.muted" mt="3">Эти продукты попадают в горячие предложения.</Text>
          </Section>
        </Grid>
      )}
      {/* Чем закончились прошлые поставки: если продукт часто пропадает по сроку — возить меньше (ТЗ 16.1). */}
      <Box mt="4">
        <SupplyReport days={periodDays(period)} from={period.from} to={period.to}
                      control={<PeriodPicker value={period} onChange={setPeriod} />} />
      </Box>
    </>
  );
}
