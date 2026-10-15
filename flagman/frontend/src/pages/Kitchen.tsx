import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Box, Button, Flex, Grid, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuExpand, LuFlame } from "react-icons/lu";
import { api } from "../api";
import { useServerNow, useSession } from "../session";
import { glue, hoursBetween, NB, ORDER_STATUS, qty, time } from "../format";
import type { BatchDto } from "../types";
import { Countdown, Loading, PageHeader, Section } from "../components/ui";
import { WriteoffDialog } from "../components/WriteoffDialog";
import { KitchenTickets } from "../components/KitchenTickets";
import { notifyError, notifyOk } from "../components/Toaster";

/**
 * Кухня (ТЗ 7): чеки на кухню (что пробила касса, ТЗ 16.15); «какую партию брать первой» — иначе учёт FEFO
 * расходится с полкой (п. 53); заготовки; очередь заказов. Крупные кнопки — под мокрые руки, режим киоска.
 */
export function KitchenPage() {
  const { loc } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useServerNow();
  const batches = useQuery({ queryKey: ["batches", loc], queryFn: () => api.batches(loc) });
  const stock = useQuery({ queryKey: ["stock", loc], queryFn: () => api.stock(loc) });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, staleTime: 60_000 });
  const orders = useQuery({ queryKey: ["orders", loc, "kitchen"], queryFn: () => api.orders(loc, undefined, 40) });
  const hot = useQuery({ queryKey: ["hot", loc], queryFn: () => api.hot(loc) });
  const [writeoff, setWriteoff] = useState<BatchDto | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  // Первая партия каждого продукта по FEFO; сначала — те, что скоро истекают.
  const takeFirst = useMemo(() => {
    const first = new Map<string, BatchDto>();
    for (const b of batches.data ?? []) {
      if (!b.blocked && b.status !== "EXPIRED" && !first.has(b.productId)) first.set(b.productId, b);
    }
    return [...first.values()].filter((b) => b.status !== "FRESH" || b.opened)
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }, [batches.data]);

  const semis = (catalog.data?.products ?? []).filter((p) => p.kind === "SEMI");
  const semiStock = new Map((stock.data ?? []).map((s) => [s.productId, s]));
  const queue = (orders.data ?? []).filter((o) => ["NEW", "ACCEPTED", "COOKING"].includes(o.status));

  const produce = async (productId: string, name: string) => {
    const amount = Number(amounts[productId] || 1000);
    try {
      const r = await api.produce(loc, productId, amount);
      notifyOk(`Приготовлено: ${name} ${r.qtyText}`, `Партия ${r.label} — распечатайте этикетку`);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
    } catch (e) {
      notifyError(e);
    }
  };
  const status = async (id: number, s: string) => {
    try {
      await api.orderStatus(loc, id, s);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader title="Кухня" subtitle="Берите партию с номером на этикетке — так учёт совпадает с полкой"
        actions={<Button variant="outline" onClick={() => document.documentElement.requestFullscreen?.()}>
          <LuExpand /> Режим киоска</Button>} />

      {!!hot.data?.offers.length && (
        <HStack mb="4" p="3" rounded="md" bg="orange.subtle" gap="3" wrap="wrap">
          <LuFlame color="var(--chakra-colors-orange-fg)" />
          <Text fontWeight="semibold" color="orange.fg">Сегодня продвигаем:</Text>
          {hot.data.offers.map((o) => <Badge key={o.variantId} colorPalette="orange" size="lg">{o.name}</Badge>)}
        </HStack>
      )}

      <Box mb="4"><KitchenTickets loc={loc} /></Box>

      <Grid templateColumns={{ base: "1fr", md: "1fr 1fr", xl: "1.1fr 1fr 0.9fr" }} gap="4" alignItems="start">
        <Section title="Бери первым">
          {batches.isLoading ? <Loading /> : takeFirst.length === 0 ? (
            <Text color="fg.muted">Все партии свежие — берите любую по порядку FEFO</Text>
          ) : (
            <Stack gap="2">
              {takeFirst.map((b) => (
                <Flex key={b.id} p="3" rounded="lg" borderWidth="2px" align="center" gap="3"
                      borderColor={b.status === "CRITICAL" ? "orange.solid" : b.status === "SOON" ? "yellow.solid" : "border"}>
                  <Box flex="1" minW="0" cursor="pointer" onClick={() => navigate(`/${loc}/batches/${b.id}`)}>
                    <Text fontWeight="semibold" textStyle={{ base: "md", sm: "lg" }} lineClamp={2}>{b.productName}</Text>
                    <HStack wrap="wrap" columnGap="2" rowGap="0">
                      <Text fontFamily="mono" fontWeight="bold" textStyle="lg">{b.label}</Text>
                      {b.opened && <Badge colorPalette="purple">вскрыта</Badge>}
                      <Text color="fg.muted">{b.qtyText}</Text>
                    </HStack>
                  </Box>
                  <Stack align="end" gap="1">
                    <Text textStyle="xl"><Countdown hours={hoursBetween(now, b.expiresAt)} status={b.status} /></Text>
                    <Button size="sm" variant="outline" colorPalette="red" onClick={() => setWriteoff(b)}>Списать</Button>
                  </Stack>
                </Flex>
              ))}
            </Stack>
          )}
        </Section>

        <Section title="Заготовки">
          <Stack gap="2">
            {semis.map((p) => {
              const s = semiStock.get(p.id);
              const first = (batches.data ?? []).find((b) => b.productId === p.id && !b.blocked);
              return (
                <Box key={p.id} p="3" rounded="lg" borderWidth="1px">
                  <HStack justify="space-between" align="start">
                    <Text fontWeight="semibold">{p.name}</Text>
                    <Text fontWeight="semibold" whiteSpace="nowrap" color={!s || s.available === 0 ? "red.fg" : undefined}>
                      {s ? s.availableText : qty(0, p.unit)}
                    </Text>
                  </HStack>
                  <HStack justify="space-between" textStyle="sm" color="fg.muted" wrap="wrap" columnGap="3" rowGap="0">
                    <Text>живёт {p.shelfLifeHours}{NB}ч</Text>
                    {first && <Text>ближайшая истекает через <Countdown hours={hoursBetween(now, first.expiresAt)} status={first.status} /></Text>}
                  </HStack>
                  <HStack mt="2">
                    <Input size="lg" type="number" placeholder="1000" value={amounts[p.id] ?? ""}
                           onChange={(e) => setAmounts({ ...amounts, [p.id]: e.target.value })} />
                    <Text color="fg.muted">г</Text>
                    <Button size="lg" colorPalette="teal" onClick={() => produce(p.id, p.name)}>Приготовить</Button>
                  </HStack>
                </Box>
              );
            })}
          </Stack>
        </Section>

        <Section title={`Очередь заказов (${queue.length})`}>
          <Stack gap="2">
            {queue.slice(0, 12).map((o) => (
              <Box key={o.id} p="3" rounded="lg" borderWidth="1px">
                <HStack justify="space-between">
                  <Text fontWeight="bold">№{o.number} · {time(o.createdAt)}</Text>
                  <Badge colorPalette={ORDER_STATUS[o.status].palette}>{ORDER_STATUS[o.status].label}</Badge>
                </HStack>
                <Text textStyle="sm">{glue(o.lines.map((l) => `${l.name} ×${l.qty}`).join(", "))}</Text>
                <HStack mt="2">
                  {o.status !== "COOKING" && <Button size="md" variant="outline" onClick={() => status(o.id, "COOKING")}>Готовлю</Button>}
                  <Button size="md" colorPalette="teal" onClick={() => status(o.id, "READY")}>Готово</Button>
                </HStack>
              </Box>
            ))}
            {queue.length === 0 && <Text color="fg.muted">Заказов нет</Text>}
          </Stack>
        </Section>
      </Grid>
      <WriteoffDialog batch={writeoff} open={!!writeoff} onClose={() => setWriteoff(null)} />
    </>
  );
}
