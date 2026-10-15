import { useState } from "react";
import { Badge, Box, CloseButton, Drawer, Flex, HStack, Portal, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { useSession } from "../session";
import { dayLabel, money, time } from "../format";
import { Empty, Loading } from "./ui";

const REASON_PALETTE: Record<string, string> = {
  WRITEOFF_EXPIRED: "orange", WRITEOFF_SPOILED: "red", WRITEOFF_DAMAGED: "purple", WRITEOFF_OTHER: "gray",
  WRITEOFF_RECALL: "cyan", WRITEOFF_SHORTAGE: "pink", CANCELED_LATE: "yellow",
};

/**
 * Потери по дням. Клик по любому месту дня (и по пустому дню тоже) открывает справа подробности:
 * что списали, сколько, кто списал и кто подписал.
 */
export function LossChart({ byDay, height = 220, fontSize = 12 }: {
  byDay: { day: string; valueKop: number }[]; height?: number; fontSize?: number;
}) {
  const [day, setDay] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const rows = byDay.map((d) => ({ date: d.day, day: d.day.slice(5).split("-").reverse().join("."), rub: Math.round(d.valueKop / 100) }));

  return (
    <>
      <Box h={`${height}px`} cursor="pointer">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} onMouseLeave={() => setHover(null)}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chakra-colors-border)" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize, fill: "var(--chakra-colors-fg-muted)" }} />
            <YAxis tick={{ fontSize, fill: "var(--chakra-colors-fg-muted)" }} width={50} />
            {/* Без серой полосы во всю высоту: выделяется сам столбик, а не колонка дня. */}
            <Tooltip cursor={false} formatter={(v) => [`${v} ₽`, "Потери"]} labelFormatter={(l) => `${l} — нажмите, чтобы открыть`} />
            {/* День берём из нажатого прямоугольника, а не из состояния подсказки: оно обновляется кадром позже,
                и быстрый клик или касание на телефоне открывали бы предыдущий день. Прозрачный фон на всю высоту —
                чтобы нажимался и день без потерь. */}
            <Bar dataKey="rub" radius={[4, 4, 0, 0]} background={{ fill: "transparent" }}
                 onMouseEnter={(_, i) => setHover(i)} onClick={(_, i) => rows[i] && setDay(rows[i].date)}>
              {/* Каждый столбик — отдельный объект: наведённый и открытый темнее, остальные приглушены. */}
              {rows.map((r, i) => {
                const focus = hover ?? rows.findIndex((x) => x.date === day);
                const on = focus < 0 || focus === i;
                return <Cell key={r.date} fill={focus === i ? "var(--chakra-colors-red-600)" : "var(--chakra-colors-red-500)"}
                             fillOpacity={on ? 1 : 0.4} style={{ transition: "fill-opacity .15s, fill .15s" }} />;
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Box>
      <Text textStyle="xs" color="fg.muted" mt="1">Нажмите на день — откроется список списаний</Text>
      <LossDayDrawer date={day} onClose={() => { setDay(null); setHover(null); }} />
    </>
  );
}

function LossDayDrawer({ date, onClose }: { date: string | null; onClose: () => void }) {
  const { loc } = useSession();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["loss-day", loc, date], queryFn: () => api.lossDay(loc, date!), enabled: !!date });
  const d = q.data;
  // Фильтр по причине: десятки системных просрочек не должны прятать пару ручных списаний — их и проверяют.
  const [only, setOnly] = useState<string | null>(null);
  const close = () => { setOnly(null); onClose(); };
  const entries = (d?.entries ?? []).filter((e) => !only || e.type === only);
  const showLate = !only || only === "CANCELED_LATE";

  return (
    <Drawer.Root open={!!date} onOpenChange={(e) => !e.open && close()} placement="end" size="md">
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content>
            <Drawer.Header>
              <Stack gap="0.5">
                <Drawer.Title>Потери · {date && dayLabel(date)}</Drawer.Title>
                {d && (
                  <Text textStyle="sm" color="fg.muted">
                    {money(d.totalKop)} · списаний: {d.entries.length}
                    {d.lateCancels.length > 0 && ` · отмен после готовки: ${d.lateCancels.length}`}
                  </Text>
                )}
              </Stack>
            </Drawer.Header>
            <Drawer.Body>
              {q.isError ? <Empty title="Не удалось загрузить день" description={(q.error as Error).message} />
                : !d ? <Loading />
                : !d.entries.length && !d.lateCancels.length ? <Empty title="В этот день потерь не было" />
                : (
                  <Stack gap="5">
                    <Flex gap="2" wrap="wrap">
                      {d.byReason.map((r) => (
                        <Badge key={r.key} size="md" cursor="pointer" colorPalette={REASON_PALETTE[r.key] ?? "gray"}
                               variant={only === r.key ? "solid" : "subtle"} opacity={only && only !== r.key ? 0.5 : 1}
                               onClick={() => setOnly(only === r.key ? null : r.key)}>
                          {r.name} · {money(r.valueKop)} · {r.count}
                        </Badge>
                      ))}
                    </Flex>
                    {d.byReason.length > 1 && (
                      <Text textStyle="xs" color="fg.muted" mt="-3">
                        {only ? "Нажмите на причину ещё раз — покажутся все" : "Нажмите на причину, чтобы оставить только её"}
                      </Text>
                    )}

                    <Stack gap="2">
                      {entries.map((e, i) => (
                        <Box key={i} p="3" borderWidth="1px" rounded="md" cursor="pointer" _hover={{ bg: "bg.muted" }}
                             onClick={() => navigate(`/${loc}/batches/${e.batchId}`)}>
                          <Flex justify="space-between" gap="3">
                            <Text fontWeight="medium">{e.productName}</Text>
                            <Text fontWeight="semibold" color="red.fg" flexShrink={0}>{money(e.costKop)}</Text>
                          </Flex>
                          <HStack gap="1.5" textStyle="sm" color="fg.muted" wrap="wrap">
                            <Text>{time(e.at)} · {e.qtyText} · партия {e.batchLabel}</Text>
                            <Badge size="sm" colorPalette={REASON_PALETTE[e.type] ?? "gray"}>{e.reason}</Badge>
                          </HStack>
                          <Text textStyle="sm" mt="1">
                            Списал: {e.author}{e.signedBy && <> · подписал: <b>{e.signedBy}</b></>}
                          </Text>
                          {e.comment && e.type !== "WRITEOFF_EXPIRED" && <Text textStyle="sm" color="fg.muted">«{e.comment}»</Text>}
                        </Box>
                      ))}
                    </Stack>

                    {showLate && d.lateCancels.length > 0 && (
                      <Stack gap="2">
                        <Text fontWeight="semibold">Отмены после готовки</Text>
                        {d.lateCancels.map((c) => (
                          <Flex key={c.orderId} p="3" borderWidth="1px" rounded="md" justify="space-between" gap="3">
                            <Box>
                              <Text fontWeight="medium">Заказ №{c.number}</Text>
                              <Text textStyle="sm" color="fg.muted">
                                {time(c.at)}{c.canceledBy && ` · отменил: ${c.canceledBy}`}{c.reason && ` · «${c.reason}»`}
                              </Text>
                            </Box>
                            <Text fontWeight="semibold" color="red.fg" flexShrink={0}>{money(c.costKop)}</Text>
                          </Flex>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                )}
            </Drawer.Body>
            <Drawer.CloseTrigger asChild><CloseButton size="sm" /></Drawer.CloseTrigger>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
