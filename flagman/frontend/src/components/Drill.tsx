import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Box, Button, CloseButton, Drawer, Flex, HStack, Portal, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { LuArrowRight } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, glue, money } from "../format";
import type { Operation } from "../types";
import { DishTable } from "../pages/Trace";
import { Empty, Kpi, Loading } from "./ui";

/** Период подробностей: дни «ГГГГ-ММ-ДД» включительно или последние days дней. */
export interface DrillPeriod { from?: string; to?: string; days?: number }

/** Куда ведёт документ операции: поставка, заказ, заготовка, заявка, возврат, пересчёт. */
export function docPath(o: Pick<Operation, "docType" | "docId" | "batchId">): string | null {
  switch (o.docType) {
    case "delivery": return o.docId ? `acceptance?delivery=${encodeURIComponent(o.docId)}` : null;
    case "order": return o.docId ? `trace?order=${o.docId}` : null;
    case "production": return o.docId ? `batches/${o.docId}` : null;
    case "writeoff": return "writeoffs?status=ALL";
    case "return": return "writeoffs?tab=returns&status=ALL";
    case "inventory": return "inventory";
    case "recall": return `batches/${o.batchId}`;
    default: return null;
  }
}

const TYPE_PALETTE: Record<string, string> = {
  RECEIPT: "green", ORDER: "blue", ORDER_RETURN: "blue", PRODUCTION_USE: "purple", PRODUCTION_OUT: "purple",
  SURPLUS: "green", RETURN_SUPPLIER: "orange",
};
const palette = (t: string) => TYPE_PALETTE[t] ?? (t.startsWith("WRITEOFF_") ? "red" : "gray");

/** Список операций: что, сколько, на сколько, кто — и ссылки на партию и документ. */
export function OperationsList({ items, onGo }: { items: Operation[]; onGo?: () => void }) {
  const { loc } = useSession();
  const navigate = useNavigate();
  const go = (to: string) => { onGo?.(); navigate(`/${loc}/${to}`); };
  if (!items.length) return <Text textStyle="sm" color="fg.muted">Операций нет</Text>;
  return (
    <Stack gap="2">
      {items.map((o) => {
        const doc = docPath(o);
        return (
          <Box key={o.id} p="2.5" borderWidth="1px" rounded="md">
            <Flex justify="space-between" gap="3" align="start">
              <Box minW="0">
                <HStack gap="1.5" wrap="wrap" rowGap="1">
                  <Badge size="sm" colorPalette={palette(o.type)}>{o.typeTitle}</Badge>
                  <Text textStyle="sm" fontWeight="medium">{o.productName}</Text>
                  <Text textStyle="sm" color={o.qty < 0 ? "red.fg" : "green.fg"} whiteSpace="nowrap">
                    {o.qty > 0 ? "+" : ""}{o.qtyText}
                  </Text>
                </HStack>
                <Text textStyle="xs" color="fg.muted" mt="0.5">
                  {dateTime(o.at)} · {o.actor}{o.author && ` · заявку подал(а) ${o.author}`}
                  {o.reason && o.type !== "WRITEOFF_EXPIRED" && ` · «${o.reason}»`}
                </Text>
              </Box>
              <Text textStyle="sm" fontWeight="medium" whiteSpace="nowrap">{money(o.costKop)}</Text>
            </Flex>
            <HStack gap="1.5" mt="1.5" wrap="wrap">
              <Button size="2xs" variant="surface" fontFamily="mono" onClick={() => go(`batches/${o.batchId}`)}>
                {o.batchLabel} <LuArrowRight />
              </Button>
              {doc && o.docLabel && (
                <Button size="2xs" variant="surface" onClick={() => go(doc)}>{o.docLabel} <LuArrowRight /></Button>
              )}
            </HStack>
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * Операции за период с фильтром (сотрудник, тип, продукт): сводка по типам — нажмите, чтобы оставить один тип,
 * и список со ссылками.
 */
export function OperationsDrawer({ open, onClose, title, subtitle, filter, period }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  filter: { actor?: string; type?: string; product?: string }; period: DrillPeriod;
}) {
  const { loc } = useSession();
  const q = useQuery({
    queryKey: ["operations", loc, filter, period], enabled: open,
    queryFn: () => api.operations(loc, { ...filter, ...period }),
  });
  const [only, setOnly] = useState<string | null>(null);
  const close = () => { setOnly(null); onClose(); };
  const d = q.data;
  const items = (d?.items ?? []).filter((o) => !only || o.type === only);
  return (
    <Drawer.Root open={open} onOpenChange={(e) => !e.open && close()} placement="end" size={{ base: "full", md: "md" }}>
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Stack gap="0.5">
                <Drawer.Title>{title}</Drawer.Title>
                <Text textStyle="sm" color="fg.muted">
                  {subtitle ? `${subtitle} · ` : ""}{d ? `${periodText(d.from, d.to)} · операций: ${d.count}` : "загрузка…"}
                </Text>
              </Stack>
            </Drawer.Header>
            <Drawer.CloseTrigger asChild><CloseButton size="sm" /></Drawer.CloseTrigger>
            <Drawer.Body>
              {q.isLoading || !d ? <Loading rows={5} /> : !d.items.length ? <Empty title="За период операций нет" /> : (
                <Stack gap="4">
                  <Flex gap="2" wrap="wrap">
                    {d.summary.map((s) => (
                      <Badge key={s.type} size="md" cursor="pointer" colorPalette={palette(s.type)}
                             variant={only === s.type ? "solid" : "subtle"} opacity={only && only !== s.type ? 0.5 : 1}
                             onClick={() => setOnly(only === s.type ? null : s.type)}>
                        {s.title} · {s.count} · {money(s.costKop)}
                      </Badge>
                    ))}
                  </Flex>
                  {d.summary.length > 1 && (
                    <Text textStyle="xs" color="fg.muted" mt="-2">
                      {only ? "Нажмите ещё раз — покажутся все" : "Нажмите на тип, чтобы оставить только его"}
                    </Text>
                  )}
                  <OperationsList items={items} onGo={close} />
                  {d.items.length < d.count && (
                    <Text textStyle="xs" color="fg.muted">Показаны последние {d.items.length} из {d.count}</Text>
                  )}
                </Stack>
              )}
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

/**
 * Продукт за период: откуда пришёл (поставки), куда ушёл (блюда — напрямую и через заготовки, заказы) и что
 * пропало (списания, просрочка). Всё со ссылками на поставку, заказ, партию.
 */
export function ProductDrawer({ productId, name, open, onClose, period }: {
  productId: string | null; name?: string; open: boolean; onClose: () => void; period: DrillPeriod;
}) {
  const { loc } = useSession();
  const navigate = useNavigate();
  const enabled = open && !!productId;
  const trace = useQuery({
    queryKey: ["trace-product", loc, productId, period], enabled,
    queryFn: () => api.traceProduct(loc, productId!, period.days ?? 7, period.from, period.to),
  });
  const ops = useQuery({
    queryKey: ["operations", loc, { product: productId }, period], enabled,
    queryFn: () => api.operations(loc, { product: productId!, ...period }),
  });
  const t = trace.data;
  const items = ops.data?.items ?? [];
  const received = items.filter((o) => o.type === "RECEIPT");
  const losses = items.filter((o) => o.type.startsWith("WRITEOFF_") || o.type === "RETURN_SUPPLIER");
  const receivedCost = received.reduce((s, o) => s + o.costKop, 0);
  const go = (to: string) => { onClose(); navigate(`/${loc}/${to}`); };
  return (
    <Drawer.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="end" size={{ base: "full", md: "lg" }}>
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Stack gap="0.5">
                <Drawer.Title>{t?.productName ?? name ?? "Продукт"}</Drawer.Title>
                <Text textStyle="sm" color="fg.muted">
                  {ops.data ? periodText(ops.data.from, ops.data.to) : "загрузка…"} · откуда пришёл, куда ушёл, что пропало
                </Text>
              </Stack>
            </Drawer.Header>
            <Drawer.CloseTrigger asChild><CloseButton size="sm" /></Drawer.CloseTrigger>
            <Drawer.Body>
              {!t || !ops.data ? <Loading rows={6} /> : (
                <Stack gap="5">
                  <SimpleGrid columns={{ base: 2, md: 4 }} gap="2">
                    <Kpi label="Привезли" value={money(receivedCost)} hint={`поставок: ${received.length}`} />
                    <Kpi label="В блюда" value={t.toDishesText} hint="напрямую и через заготовки" />
                    {!t.semi && <Kpi label="В заготовки" value={t.toPrepsText} />}
                    <Kpi label="Пропало" value={t.lostText} palette={t.lost > 0 ? "red" : undefined} hint="списания, просрочка" />
                  </SimpleGrid>

                  <Box>
                    <Text fontWeight="semibold" mb="2">Откуда: поставки</Text>
                    <OperationsList items={received} onGo={onClose} />
                  </Box>

                  <Box>
                    <Text fontWeight="semibold" mb="2">Куда: блюда</Text>
                    {t.dishes.length ? <DishTable rows={t.dishes} showVia /> : <Text textStyle="sm" color="fg.muted">В блюда не уходил</Text>}
                  </Box>

                  {t.orders.length > 0 && (
                    <Box>
                      <Text fontWeight="semibold" mb="2">Последние заказы с ним</Text>
                      <Stack gap="1">
                        {t.orders.slice(0, 15).map((o, i) => (
                          <Flex key={`${o.orderId}-${i}`} justify="space-between" gap="3" textStyle="sm" cursor="pointer"
                                _hover={{ color: "brand.fg" }} onClick={() => go(`trace?order=${o.orderId}`)}>
                            <Text minW="0" truncate>
                              <Text as="span" fontWeight="medium">№{o.number}</Text> · {glue(o.dish)}
                              {o.via && <Text as="span" color="purple.fg"> · через «{o.via}»</Text>}
                            </Text>
                            <HStack gap="1" flexShrink={0}><Text>{o.via ? "≈ " : ""}{o.qtyText}</Text><LuArrowRight /></HStack>
                          </Flex>
                        ))}
                      </Stack>
                    </Box>
                  )}

                  <Box>
                    <Text fontWeight="semibold" mb="2">Что пропало: списания и просрочка</Text>
                    <OperationsList items={losses} onGo={onClose} />
                  </Box>

                  <Button variant="outline" size="sm" alignSelf="flex-start" onClick={() => go(`trace`)}>
                    Прослеживаемость <LuArrowRight />
                  </Button>
                </Stack>
              )}
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

/** «07.10 — 13.10» или «13.10» для одного дня. */
function periodText(from: string, to: string) {
  const f = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  return from === to ? f(from) : `${f(from)} — ${f(to)}`;
}
