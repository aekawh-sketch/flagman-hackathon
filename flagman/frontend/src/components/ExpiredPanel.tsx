import { useState } from "react";
import { Badge, Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuTimerOff, LuTrash2 } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, money, NB, plural, timeLeft } from "../format";
import { Section } from "./ui";
import { notifyError, notifyOk } from "./Toaster";

/**
 * Партии под списанием (ТЗ 16.1, шаг 6): срок истёк — из продаж они ушли сами, а списывает человек.
 * Свежую партию так не спишешь: сервер проверяет срок по своим часам.
 */
export function ExpiredPanel() {
  const { loc, can } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["expired", loc], queryFn: () => api.expired(loc), refetchInterval: 30_000 });
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const items = list.data ?? [];
  if (!items.length) return null;
  const total = items.reduce((s, b) => s + b.costKop, 0);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
  const one = async (batchId: number, name: string) => {
    setBusy(batchId);
    try {
      const r = await api.writeOffExpired(loc, batchId);
      notifyOk(`Списано: ${name}`, `${money(r.costKop)} — в журнале записано, кто списал`);
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const all = async () => {
    if (!window.confirm(`Списать всю просрочку: ${items.length} ${plural(items.length, ["партию", "партии", "партий"])} на ${money(total)}?`)) return;
    setBusy("all");
    try {
      const r = await api.writeOffAllExpired(loc);
      notifyOk(`Списано партий: ${r.batches}`);
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section borderColor="red.muted" title={
      <Flex as="span" gap="2" align="center" wrap="wrap">
        <Box as="span" color="red.fg"><LuTimerOff /></Box>
        Просрочка ждёт списания
        <Badge colorPalette="red">{items.length}{NB}{plural(items.length, ["партия", "партии", "партий"])} · {money(total)}</Badge>
      </Flex>}
      actions={can("STOREKEEPER", "MANAGER", "ADMIN") && (
        <Button size="sm" colorPalette="red" loading={busy === "all"} onClick={all}><LuTrash2 /> Списать всё</Button>
      )}>
      <Text textStyle="sm" color="fg.muted" mb="3">
        Срок истёк — эти партии уже не продаются и не попадают в заказы. Уберите их с полки и спишите: в журнал запишется, кто и когда.
      </Text>
      <Stack gap="0" divideY="1px">
        {items.map((b) => (
          <Flex key={b.batchId} py="2.5" gap="3" align="center" wrap="wrap">
            <Box flex="1" minW="44">
              <Text fontWeight="medium">{b.productName} <Text as="span" fontFamily="mono" color="fg.muted" textStyle="sm">{b.label}</Text></Text>
              <Text textStyle="xs" color="fg.muted">
                истёк {dateTime(b.expiredAt)} · лежит {b.hoursAgo < 0.02 ? "только что" : timeLeft(b.hoursAgo)}
              </Text>
            </Box>
            <Box textAlign="end">
              <Text whiteSpace="nowrap">{b.qtyText}</Text>
              <Text textStyle="xs" color="red.fg" whiteSpace="nowrap">{money(b.costKop)}</Text>
            </Box>
            <Button size="sm" variant="outline" colorPalette="red" loading={busy === b.batchId}
                    onClick={() => one(b.batchId, b.productName)}>Списать</Button>
          </Flex>
        ))}
      </Stack>
    </Section>
  );
}
