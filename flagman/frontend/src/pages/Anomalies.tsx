import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Badge, Box, Button, Card, CloseButton, Dialog, Flex, HStack, Input, Portal, SimpleGrid, Stack, Text, Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuArrowRight, LuCheck, LuShieldAlert, LuX } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, money } from "../format";
import type { Anomaly } from "../types";
import { Empty, Loading, PageHeader, Segments } from "../components/ui";
import { PhotoStrip } from "../components/PhotoViewer";
import { minusDays, useServerToday } from "../components/PeriodPicker";
import { notifyError, notifyOk } from "../components/Toaster";

const STATUS: Record<string, { label: string; palette: string }> = {
  NEW: { label: "новая", palette: "red" },
  REVIEWED: { label: "проверена", palette: "blue" },
  CONFIRMED: { label: "подозрение подтверждено", palette: "purple" },
  FALSE: { label: "ложная тревога", palette: "gray" },
};
const WRITEOFF_STATUS: Record<string, string> = { PENDING: "ждёт решения", EXECUTED: "списано", REJECTED: "отклонено" };
/** Решить можно новую и старую «проверенную»; подтверждённая и ложная — уже разобраны. */
const open = (a: Anomaly) => a.status === "NEW" || a.status === "REVIEWED";


/**
 * Подозрительные операции (ТЗ 6.11): правило, сотрудник, цифры. Решений два — подтвердить подозрение или
 * отметить ложной тревогой. Клик открывает подробности: заявки с фото, партии, поставки — и куда перейти.
 */
export function AnomaliesPage() {
  const { loc } = useSession();
  const [status, setStatus] = useState("NEW");
  // Период — от «сегодня» по часам сервера: в демо время бывает впереди компьютера, и свежие операции
  // иначе не попали бы в «последние 30 дней». Пока период не выбирали — он идёт за серверным «сегодня».
  const today = useServerToday();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const from = range ? range.from : minusDays(today, 29);
  const to = range ? range.to : today;
  const setFrom = (v: string) => setRange({ from: v, to });
  const setTo = (v: string) => setRange({ from, to: v });
  // Открытая операция — в адресе: ушли в партию или поставку и вернулись «Назад» — окно снова открыто.
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get("id")) || null;
  const setOpenId = (id: number | null) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (id) next.set("id", String(id));
    else next.delete("id");
    return next;
  }, { replace: true });
  const list = useQuery({
    queryKey: ["anomalies", loc, status, from, to],
    queryFn: () => api.anomalies(loc, status === "ALL" ? undefined : status, from || undefined, to || undefined),
  });
  const preset = (days: number | null) =>
    setRange(days === null ? { from: "", to: "" } : { from: minusDays(today, days - 1), to: today });

  return (
    <>
      <PageHeader title="Подозрительные операции"
        subtitle="8 правил: кто списывает больше других, списание свежего, списания перед закрытием, дорогие позиции, поздние отмены, рост граммовки, повторные недостачи и расхождения приёмки. Нажмите на операцию — откроются подробности."
        actions={
          <Segments value={status} onChange={setStatus} items={[{ value: "NEW", label: "Новые" },
            { value: "CONFIRMED", label: "Подтверждены" }, { value: "FALSE", label: "Ложные" }, { value: "ALL", label: "Все" }]} />} />

      <Flex gap="2" mb="4" align="center" wrap="wrap">
        <Text textStyle="sm" color="fg.muted">Период с</Text>
        <Input type="date" size="sm" w="40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
               aria-label="Период: с" />
        <Text textStyle="sm" color="fg.muted">по</Text>
        <Input type="date" size="sm" w="40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
               aria-label="Период: по" />
        <HStack gap="1" wrap="wrap">
          <Button size="xs" variant="ghost" onClick={() => preset(1)}>Сегодня</Button>
          <Button size="xs" variant="ghost" onClick={() => preset(7)}>7 дней</Button>
          <Button size="xs" variant="ghost" onClick={() => preset(30)}>30 дней</Button>
          <Button size="xs" variant="ghost" onClick={() => preset(null)}>Всё время</Button>
        </HStack>
      </Flex>

      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <Empty icon={<LuShieldAlert />} title="Подозрительного нет" description="За выбранный период и с этим статусом операций нет" />
      ) : (
        <Stack gap="3">
          {list.data.map((a) => <AnomalyCard key={a.id} a={a} onOpen={() => setOpenId(a.id)} />)}
        </Stack>
      )}
      {openId && <AnomalyDialog id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function useReview() {
  const { loc } = useSession();
  const qc = useQueryClient();
  return async (id: number, status: "CONFIRMED" | "FALSE", comment = "") => {
    try {
      await api.reviewAnomaly(loc, id, status, comment);
      notifyOk(status === "CONFIRMED" ? "Подозрение подтверждено" : "Отмечено как ложная тревога");
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    }
  };
}

function AnomalyCard({ a, onOpen }: { a: Anomaly; onOpen: () => void }) {
  const review = useReview();
  return (
    <Card.Root variant="outline" cursor="pointer" _hover={{ borderColor: "border.emphasized", bg: "bg.subtle" }}
               onClick={onOpen}>
      <Card.Body>
        {/* На телефоне — колонкой: текст на всю ширину, кнопки решения под ним. */}
        <Flex direction={{ base: "column", md: "row" }} justify="space-between" align={{ base: "stretch", md: "start" }} gap="3">
          <Box flex="1" minW="0">
            <HStack mb="1" gap="2" wrap="wrap" rowGap="1">
              <Badge variant="solid" colorPalette="red">{a.rule}</Badge>
              <Text fontWeight="semibold">{a.ruleTitle}</Text>
              <Badge colorPalette={STATUS[a.status].palette}>{STATUS[a.status].label}</Badge>
            </HStack>
            <Text>{a.title}</Text>
            <Text textStyle="xs" color="fg.muted" mt="1">
              {dateTime(a.detectedAt)}{a.actorName ? ` · сотрудник: ${a.actorName}` : ""}
              {a.reviewedBy ? ` · разобрал(а) ${a.reviewedBy}` : ""}{a.comment ? ` — ${a.comment}` : ""}
            </Text>
            <Text textStyle="xs" color="brand.fg" mt="1">Подробнее →</Text>
          </Box>
          {open(a) && (
            <HStack flexShrink={0} gap="2" onClick={(e) => e.stopPropagation()}>
              <Button size={{ base: "sm", md: "xs" }} flex={{ base: "1 1 auto", md: "initial" }} colorPalette="purple"
                      onClick={() => review(a.id, "CONFIRMED")}><LuCheck /> Подтвердить</Button>
              <Button size={{ base: "sm", md: "xs" }} flex={{ base: "1 1 auto", md: "initial" }} variant="outline"
                      onClick={() => review(a.id, "FALSE")}><LuX /> Ложная</Button>
            </HStack>
          )}
        </Flex>
      </Card.Body>
    </Card.Root>
  );
}

/** Подробности: как сработало правило, цифры, заявки с фото, отмены — и куда перейти разбираться. */
function AnomalyDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { loc } = useSession();
  const navigate = useNavigate();
  const review = useReview();
  const q = useQuery({ queryKey: ["anomaly", loc, id], queryFn: () => api.anomaly(loc, id) });
  const [comment, setComment] = useState("");
  const d = q.data;
  const a = d?.anomaly;
  const go = (to: string) => navigate(`/${loc}/${to}`);
  const decide = async (s: "CONFIRMED" | "FALSE") => {
    if (await review(id, s, comment.trim())) onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} placement="center" scrollBehavior="inside"
                 size={{ base: "full", md: "lg" }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              {a ? (
                <Stack gap="1.5">
                  <HStack gap="2" wrap="wrap">
                    <Badge variant="solid" colorPalette="red">{a.rule}</Badge>
                    <Dialog.Title>{a.ruleTitle}</Dialog.Title>
                  </HStack>
                  <Badge alignSelf="flex-start" colorPalette={STATUS[a.status].palette}>{STATUS[a.status].label}</Badge>
                </Stack>
              ) : <Dialog.Title>Подозрительная операция</Dialog.Title>}
            </Dialog.Header>
            <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
            <Dialog.Body>
              {q.isLoading || !d || !a ? <Loading rows={4} /> : (
                <Stack gap="4">
                  <Box>
                    <Text fontWeight="medium">{a.title}</Text>
                    <Text textStyle="sm" color="fg.muted">
                      {dateTime(a.detectedAt)}{a.actorName ? ` · сотрудник: ${a.actorName}` : ""}
                    </Text>
                  </Box>

                  <Box p="3" rounded="md" bg="bg.muted">
                    <Text textStyle="xs" color="fg.muted" mb="1">Почему сработало правило</Text>
                    <Text textStyle="sm">{d.ruleHow}</Text>
                  </Box>

                  {d.facts.length > 0 && (
                    <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                      {d.facts.map((f) => (
                        <Box key={f.label}>
                          <Text textStyle="xs" color="fg.muted">{f.label}</Text>
                          <Text textStyle="sm" fontWeight="medium">{f.value}</Text>
                        </Box>
                      ))}
                    </SimpleGrid>
                  )}

                  {d.writeoffs.length > 0 && (
                    <Box>
                      <Text textStyle="sm" fontWeight="semibold" mb="2">
                        {d.writeoffs.length === 1 ? "Заявка на списание" : `Заявки на списание (${d.writeoffs.length})`}
                      </Text>
                      <Stack gap="2">
                        {d.writeoffs.map((w) => (
                          <HStack key={w.id} align="start" gap="3" p="2.5" borderWidth="1px" rounded="md">
                            {w.hasPhoto && <PhotoStrip srcs={Array.from({ length: w.photoCount || 1 },
                              (_, i) => api.writeoffPhotoUrl(loc, w.id, i))} alt={`Фото: ${w.productName}`} size="14" max={2} />}
                            <Stack gap="0.5" flex="1" minW="0">
                              <Flex justify="space-between" gap="2" wrap="wrap">
                                <Text textStyle="sm" fontWeight="medium">{w.productName} · {w.qtyText}</Text>
                                <Text textStyle="sm" whiteSpace="nowrap">{money(w.costKop)}</Text>
                              </Flex>
                              <Text textStyle="xs" color="fg.muted">
                                {w.reason}{w.comment ? ` — «${w.comment}»` : ""} · {dateTime(w.createdAt)} · {WRITEOFF_STATUS[w.status]}
                              </Text>
                              <Text textStyle="xs" color={w.leftPercent > 50 ? "red.fg" : "fg.muted"}>
                                срока у партии оставалось {w.leftPercent} %
                              </Text>
                              <HStack gap="1.5" mt="1" wrap="wrap">
                                <Button size="2xs" variant="surface" fontFamily="mono" onClick={() => go(`batches/${w.batchId}`)}>
                                  {w.batchLabel} <LuArrowRight />
                                </Button>
                                {w.deliveryId && (
                                  <Button size="2xs" variant="surface" onClick={() => go(`acceptance?delivery=${encodeURIComponent(w.deliveryId!)}`)}>
                                    поставка {w.deliveryNumber} <LuArrowRight />
                                  </Button>
                                )}
                              </HStack>
                            </Stack>
                          </HStack>
                        ))}
                      </Stack>
                    </Box>
                  )}

                  {d.orders.length > 0 && (
                    <Box>
                      <Text textStyle="sm" fontWeight="semibold" mb="2">Отмены после начала готовки</Text>
                      <Stack gap="1">
                        {d.orders.map((o) => (
                          <Flex key={o.id} justify="space-between" gap="3" textStyle="sm">
                            <Text minW="0">
                              №{o.number} · {dateTime(o.canceledAt)}{o.reason ? ` — «${o.reason}»` : ""}
                            </Text>
                            <Text whiteSpace="nowrap" color="red.fg">{money(o.costKop)}</Text>
                          </Flex>
                        ))}
                      </Stack>
                    </Box>
                  )}

                  {d.links.length > 0 && (
                    <Box>
                      <Text textStyle="sm" fontWeight="semibold" mb="2">Перейти</Text>
                      <HStack gap="2" wrap="wrap">
                        {d.links.map((l) => (
                          <Button key={l.to} size="sm" variant="outline" onClick={() => go(l.to)}>
                            {l.label} <LuArrowRight />
                          </Button>
                        ))}
                      </HStack>
                    </Box>
                  )}

                  {open(a) ? (
                    <Box>
                      <Text textStyle="sm" fontWeight="semibold" mb="2">Решение</Text>
                      <Textarea size="sm" rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
                                placeholder="Комментарий, если нужен: «поговорил с сотрудником», «товар действительно испорчен»" />
                    </Box>
                  ) : (
                    <Text textStyle="sm" color="fg.muted">
                      Разобрал(а): {a.reviewedBy ?? "—"}{a.comment ? ` — «${a.comment}»` : ""}
                    </Text>
                  )}
                </Stack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              {a && open(a) ? (
                <>
                  <Button variant="outline" onClick={() => decide("FALSE")}><LuX /> Ложная тревога</Button>
                  <Button colorPalette="purple" onClick={() => decide("CONFIRMED")}><LuCheck /> Подтвердить подозрение</Button>
                </>
              ) : <Button variant="outline" onClick={onClose}>Закрыть</Button>}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
