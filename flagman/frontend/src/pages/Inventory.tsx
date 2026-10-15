import { useMemo, useState } from "react";
import { Badge, Box, Button, Flex, HStack, Input, Stack, Table, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, money } from "../format";
import { Empty, Loading, PageHeader, Section } from "../components/ui";
import { PeriodPicker, usePeriod } from "../components/PeriodPicker";
import { notifyError, notifyOk } from "../components/Toaster";

const STATUS: Record<string, { label: string; palette: string }> = {
  OPEN: { label: "идёт пересчёт", palette: "blue" },
  AWAITING_APPROVAL: { label: "ждёт подтверждения", palette: "orange" },
  CONFIRMED: { label: "проведена", palette: "green" },
  CANCELED: { label: "отменена", palette: "gray" },
};

/**
 * Инвентаризация (ТЗ 6.10): система фиксирует момент T, продажи не останавливаются;
 * ожидаемое на T точно считается по журналу.
 */
export function InventoryPage() {
  const { loc, can } = useSession();
  // Пересчёт ведут кладовщик и управляющий; админ видит ход и итог, но сам не считает (ТЗ 6.2)
  const counter = can("STOREKEEPER", "MANAGER");
  const qc = useQueryClient();
  // Период истории пересчётов «с … по …»; незавершённый пересчёт виден всегда — его нужно довести.
  const [period, setPeriod] = usePeriod(30);
  const counts = useQuery({ queryKey: ["inventory", loc, period.from, period.to],
    queryFn: () => api.inventory(loc, period.from, period.to) });
  const stock = useQuery({ queryKey: ["stock", loc], queryFn: () => api.stock(loc) });
  const active = counts.data?.find((c) => c.status === "OPEN" || c.status === "AWAITING_APPROVAL");
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const refresh = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifyOk(ok);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  // Введённый факт уходит вместе с проведением — отдельно сохранять не нужно
  const submit = async () => {
    if (!active) return;
    const lines = Object.entries(facts).filter(([, v]) => v !== "").map(([productId, v]) => ({ productId, actual: Number(v) }));
    if (!lines.length && !active.lines.length) {
      notifyError(new Error("Введите факт хотя бы по одному продукту"));
      return;
    }
    try {
      const done = await api.submitInventory(loc, active.id, lines);
      setFacts({});
      notifyOk(done.status === "AWAITING_APPROVAL" ? "Отправлено: расхождение крупное — ждёт подтверждения управляющего"
        : "Инвентаризация проведена");
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const products = useMemo(() => (stock.data ?? [])
    .filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase())), [stock.data, search]);

  return (
    <>
      <PageHeader title="Инвентаризация" subtitle="Расхождение по журналу на момент начала пересчёта: продажи во время пересчёта не мешают."
        actions={
          <Flex gap="3" align="center" wrap="wrap" justify="flex-end">
            <PeriodPicker value={period} onChange={setPeriod} />
            {!active && can("STOREKEEPER", "MANAGER") && (
              <Button colorPalette="teal" onClick={() => run(() => api.startInventory(loc), "Пересчёт начат — момент T зафиксирован")}>
                Начать пересчёт
              </Button>)}
          </Flex>
        } />
      {active && (
        <Section mb="4" title={<HStack>Пересчёт от {dateTime(active.startedAt)} <Badge colorPalette={STATUS[active.status].palette}>{STATUS[active.status].label}</Badge></HStack>}
          actions={active.status === "OPEN" ? counter && (
            <Button size="sm" colorPalette="teal" onClick={submit}>
              Провести
            </Button>
          ) : can("MANAGER") ? (
            <Button size="sm" colorPalette="orange" onClick={() => run(() => api.confirmInventory(loc, active.id), "Инвентаризация проведена")}>
              Подтвердить
            </Button>
          ) : <Text textStyle="sm" color="fg.muted">ждёт подтверждения управляющего</Text>}>
          {!counter && (
            <Text textStyle="sm" color="fg.muted" mb="3">
              Пересчёт ведут кладовщик и управляющий: вводят факт и проводят, крупное расхождение подтверждает управляющий.
              Здесь видно, как он идёт, а итог появится в «Истории».
            </Text>
          )}
          {active.lines.length > 0 && (
            <Box mb="4">
              <Text fontWeight="semibold" mb="2">Расхождения</Text>
              <LinesTable lines={active.lines} />
            </Box>
          )}
          {active.status === "OPEN" && counter && (
            <>
              <Input size="sm" mb="2" maxW="xs" placeholder="Поиск продукта" value={search} onChange={(e) => setSearch(e.target.value)} />
              <Stack gap="1" maxH="60vh" overflowY="auto">
                {products.map((p) => (
                  <HStack key={p.productId} justify="space-between" py="1" borderBottomWidth="1px">
                    <Box>
                      <Text textStyle="sm" fontWeight="medium">{p.name}</Text>
                      <Text textStyle="xs" color="fg.muted">по системе сейчас: {p.availableText}</Text>
                    </Box>
                    <HStack>
                      <Input size="sm" w="32" type="number" placeholder="факт" value={facts[p.productId] ?? ""}
                             onChange={(e) => setFacts({ ...facts, [p.productId]: e.target.value })} />
                      <Text textStyle="xs" color="fg.muted" w="6">{p.unit === "PCS" ? "шт" : p.unit === "ML" ? "мл" : "г"}</Text>
                    </HStack>
                  </HStack>
                ))}
              </Stack>
            </>
          )}
        </Section>
      )}
      <Section title="История">
        {counts.isLoading ? <Loading /> : !counts.data?.filter((c) => c.status === "CONFIRMED").length ? <Empty title="Проведённых инвентаризаций нет" /> : (
          <Stack gap="4">
            {counts.data.filter((c) => c.status === "CONFIRMED").map((c) => (
              <Box key={c.id}>
                <HStack mb="1">
                  <Text fontWeight="semibold">№{c.id} · {dateTime(c.startedAt)}</Text>
                  <Text color="fg.muted" textStyle="sm">начал(а) {c.startedBy}, провёл(а) {c.confirmedBy} · расхождение {money(c.diffKop ?? 0)}</Text>
                </HStack>
                <LinesTable lines={c.lines.filter((l) => l.diff !== 0)} />
              </Box>
            ))}
          </Stack>
        )}
      </Section>
    </>
  );
}

function LinesTable({ lines }: { lines: import("../types").InventoryLine[] }) {
  if (!lines.length) return <Text textStyle="sm" color="fg.muted">Расхождений нет</Text>;
  return (
    <Table.Root size="sm">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>Продукт</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Ожидалось на T</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Факт</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Разница</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Сумма</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {lines.map((l) => (
          <Table.Row key={l.productId}>
            <Table.Cell>{l.productName}</Table.Cell>
            <Table.Cell textAlign="end">{l.expectedText}</Table.Cell>
            <Table.Cell textAlign="end">{l.actualText}</Table.Cell>
            <Table.Cell textAlign="end" color={l.diff < 0 ? "red.fg" : l.diff > 0 ? "green.fg" : undefined}>{l.diffText}</Table.Cell>
            <Table.Cell textAlign="end">{money(l.diffKop)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}
