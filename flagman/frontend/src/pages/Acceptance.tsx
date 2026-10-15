import { useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Badge, Box, Button, Checkbox, CloseButton, Dialog, Field, Flex, HStack, IconButton, Input, Menu, Portal,
  SimpleGrid, Stack, Table, Text, Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuCamera, LuChevronRight, LuDownload, LuFileUp, LuFlaskConical, LuPlus, LuTrash2, LuUndo2, LuX } from "react-icons/lu";
import { api, ApiError } from "../api";
import { useServerNow, useSession } from "../session";
import { PhotoStrip } from "../components/PhotoViewer";
import { PhotoPicker } from "../components/PhotoPicker";
import { RETURNABLE, ReturnDialog } from "../components/ReturnDialog";
import { dateTime, money, NB, plural, qty, STATUS as BATCH, timeLeft } from "../format";
import type { BatchStatus, CatalogProduct, DeliveryDto, DeliveryIn, RejectReason } from "../types";
import { Empty, Loading, PageHeader, Section } from "../components/ui";
import { Choice } from "../components/Choice";
import { SearchSelect } from "../components/SearchSelect";
import { notifyError, notifyOk } from "../components/Toaster";

const STATUS: Record<string, { label: string; palette: string }> = {
  PENDING: { label: "ждёт одобрения", palette: "purple" },
  APPROVED: { label: "одобрена — ждёт приёмки", palette: "blue" },
  ACCEPTED: { label: "принята", palette: "green" },
  PARTIAL: { label: "принята частично", palette: "orange" },
  ACCEPTED_DIFF: { label: "принята с излишком", palette: "orange" },
  REJECTED: { label: "отклонена", palette: "red" },
};

const REASONS: Record<RejectReason, string> = {
  SHORTAGE: "недовоз",
  DEFECT: "брак",
  EXPIRED: "просрочено",
  NOT_ORDERED: "не заказывали",
  NOT_APPROVED: "не одобрено управляющим",
  OTHER: "прочее",
};

/** Причины, которые выбирает кладовщик; «не одобрено» ставит система. */
const DOOR_REASONS: RejectReason[] = ["SHORTAGE", "DEFECT", "EXPIRED", "NOT_ORDERED", "OTHER"];

const CHANNEL: Record<string, string> = { API: "API", FORM: "форма", FILE: "файл" };

/**
 * Приёмка (ТЗ 5.1, 16.1, 16.6): поставка приходит документом — из формы, файлом XML/JSON или по API.
 * Сначала управляющий одобряет, что из накладной берём (целиком или частично), потом другой сотрудник —
 * кладовщик — принимает по факту, не больше одобренного. Система сроков работает уже здесь: по каждой
 * строке видно «годна до» и статус; просроченное принять нельзя.
 */
export function AcceptancePage() {
  const { loc, can } = useSession();
  const deliveries = useQuery({ queryKey: ["deliveries", loc], queryFn: () => api.deliveries(loc) });
  const list = deliveries.data ?? [];
  const toApprove = list.filter((d) => d.status === "PENDING");
  const toReceive = list.filter((d) => d.status === "APPROVED");
  const done = list.filter((d) => d.status !== "PENDING" && d.status !== "APPROVED").slice(0, 20);
  const manager = can("MANAGER", "ADMIN");
  // Принимает по факту у двери кладовщик или управляющий; админ одобряет, но сам не принимает (ТЗ 6.2)
  const receiver = can("STOREKEEPER", "MANAGER");
  const [form, setForm] = useState(false);
  // Открытая поставка живёт в адресе (?delivery=ID): ушли в партию и вернулись «Назад» — окно снова открыто.
  const [params, setParams] = useSearchParams();
  const details = list.find((d) => d.id === params.get("delivery")) ?? null;
  const setDetails = (d: DeliveryDto | null) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (d) next.set("delivery", d.id);
    else next.delete("delivery");
    return next;
  }, { replace: true });
  return (
    <>
      <PageHeader title="Приёмка" subtitle="Управляющий одобряет поставку целиком или частично, кладовщик принимает по факту — продукты появляются на складе только после этого"
                  actions={<>
                    <Button size="sm" colorPalette="teal" onClick={() => setForm((v) => !v)}><LuPlus /> Новая поставка</Button>
                    <UploadButton />
                    <SampleMenu />
                  </>} />
      <Stack gap="4">
        {form && <NewDelivery onDone={() => setForm(false)} />}
        {deliveries.isLoading ? <Loading /> : (
          <>
            {toApprove.map((d) => manager ? <ApprovalCard key={d.id} d={d} /> : <WaitingApproval key={d.id} d={d} />)}
            {toReceive.map((d) => receiver ? <PendingDelivery key={d.id} d={d} /> : (
              <WaitingApproval key={d.id} d={d} badge="одобрена — ждёт приёмки" palette="blue"
                               text="Принимает кладовщик или управляющий: сверяет факт с накладной у двери и фотографирует её." />
            ))}
            {toApprove.length + toReceive.length === 0 && (
              <Section title="Ждут одобрения и приёмки">
                <Empty title="Новых поставок нет" description="Создайте поставку формой, загрузите файл XML или JSON — или она придёт по API" />
              </Section>
            )}
          </>
        )}
        <Section title="Последние поставки">
          {done.length === 0 ? <Text color="fg.muted" textStyle="sm">Пока ни одной</Text> : (
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Номер</Table.ColumnHeader>
                  <Table.ColumnHeader hideBelow="md">Поставщик</Table.ColumnHeader>
                  <Table.ColumnHeader hideBelow="sm">Создана</Table.ColumnHeader>
                  <Table.ColumnHeader hideBelow="lg" whiteSpace="nowrap">Одобрил · принял</Table.ColumnHeader>
                  <Table.ColumnHeader>Статус</Table.ColumnHeader>
                  <Table.ColumnHeader w="1" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {done.map((d) => {
                  const rejected = d.lines.filter((l) => l.rejectReason);
                  return (
                    <Table.Row key={d.id} cursor="pointer" _hover={{ bg: "bg.muted" }} onClick={() => setDetails(d)}>
                      <Table.Cell>
                        <HStack gap="1.5" wrap="wrap">
                          <Text fontFamily="mono" whiteSpace="nowrap">{d.number}</Text>
                          {d.mock && <Badge size="sm" colorPalette="purple">тест</Badge>}
                          <Badge size="sm" variant="outline">{CHANNEL[d.channel]}</Badge>
                        </HStack>
                        <Text hideFrom="md" textStyle="xs" color="fg.muted">
                          {d.supplier} · {dateTime(d.createdAt)}
                        </Text>
                        {d.hasInvoicePhoto && (
                          <Box mt="1.5" onClick={(e) => e.stopPropagation()}>
                            <PhotoStrip srcs={Array.from({ length: d.invoicePhotoCount || 1 }, (_, i) => api.invoicePhotoUrl(loc, d.id, i))}
                                        alt={`Накладная ${d.number}`} size="12" />
                          </Box>
                        )}
                      </Table.Cell>
                      <Table.Cell hideBelow="md">{d.supplier}</Table.Cell>
                      <Table.Cell hideBelow="sm" whiteSpace="nowrap">{dateTime(d.createdAt)}</Table.Cell>
                      <Table.Cell hideBelow="lg" textStyle="sm">
                        {d.approvedBy ?? "—"} · {d.acceptedBy ?? "автоприёмка"}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge colorPalette={STATUS[d.status]?.palette}>{STATUS[d.status]?.label ?? d.status}</Badge>
                        {rejected.map((l) => (
                          <Text key={l.lineNo} textStyle="xs" color="fg.muted" mt="1">
                            {l.name}: {l.qtyActualText ?? 0} из {l.qtyText} — {REASONS[l.rejectReason!]}
                            {l.rejectComment || l.approveNote ? ` (${l.rejectComment || l.approveNote})` : ""}
                          </Text>
                        ))}
                        {d.rejectComment && <Text textStyle="xs" color="fg.muted" mt="1">{d.rejectComment}</Text>}
                      </Table.Cell>
                      <Table.Cell textAlign="end">
                        <IconButton aria-label={`Подробности поставки ${d.number}`} size="xs" variant="ghost"
                                    onClick={(e) => { e.stopPropagation(); setDetails(d); }}>
                          <LuChevronRight />
                        </IconButton>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
        </Section>
      </Stack>
      <DeliveryDetails d={details} onClose={() => setDetails(null)} />
    </>
  );
}

/**
 * Подробности уже обработанной поставки: кто и когда одобрил и принял, что по каждой строке было
 * в накладной, сколько одобрили и приняли, почему не взяли, и в какую партию на складе это легло.
 */
function DeliveryDetails({ d, onClose }: { d: DeliveryDto | null; onClose: () => void }) {
  const { loc, can } = useSession();
  const navigate = useNavigate();
  // Возврат поставщику прямо из подробностей: поставка уже выбрана; ниже — какие возвраты по ней уже были.
  const canReturn = can("STOREKEEPER", "MANAGER", "ADMIN");
  const [returning, setReturning] = useState(false);
  const returns = useQuery({
    queryKey: ["returns", loc, "delivery", d?.id], enabled: !!d && canReturn,
    queryFn: () => api.returns(loc, { deliveryId: d!.id }),
  });
  // До какого места долистали — чтобы после возврата из партии окно открылось там же.
  const scrollKey = d ? `delivery-scroll:${d.id}` : "";
  const restoreScroll = (el: HTMLDivElement | null) => {
    if (!el || !scrollKey) return;
    const saved = Number(sessionStorage.getItem(scrollKey) ?? 0);
    if (!saved) return;
    sessionStorage.removeItem(scrollKey);          // один раз: при живых обновлениях окно не прыгает назад
    requestAnimationFrame(() => { el.scrollTop = saved; });
  };
  const bodyRef = useRef<HTMLDivElement | null>(null);
  if (!d) return null;
  const st = STATUS[d.status];
  const invoiceKop = d.lines.reduce((s, l) => s + (l.costKop ?? 0), 0);
  const acceptedKop = d.lines.reduce((s, l) => s + (l.costKop && l.qtyActual
    ? Math.round(l.costKop * Math.min(l.qtyActual, l.qtyInvoice) / l.qtyInvoice) : 0), 0);
  const acceptedLines = d.lines.filter((l) => (l.qtyActual ?? 0) > 0).length;
  const fact = (label: string, value: ReactNode, note?: string | null) => (
    <Box>
      <Text textStyle="xs" color="fg.muted">{label}</Text>
      <Text textStyle="sm" fontWeight="medium">{value}</Text>
      {note && <Text textStyle="xs" color="fg.muted">«{note}»</Text>}
    </Box>
  );
  return (
    <Dialog.Root open onOpenChange={(e) => {
      if (e.open) return;
      sessionStorage.removeItem(scrollKey);       // закрыли сами — в следующий раз с начала
      onClose();
    }} placement="center" scrollBehavior="inside"
                 size={{ base: "full", md: "lg" }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Stack gap="1.5">
                <Dialog.Title>Поставка <Text as="span" fontFamily="mono">{d.number}</Text></Dialog.Title>
                <HStack gap="1.5" wrap="wrap">
                  <Badge colorPalette={st?.palette}>{st?.label ?? d.status}</Badge>
                  <Badge variant="outline">{CHANNEL[d.channel]}</Badge>
                  {d.mock && <Badge colorPalette="purple">тест</Badge>}
                </HStack>
              </Stack>
            </Dialog.Header>
            <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
            <Dialog.Body ref={(el: HTMLDivElement | null) => { bodyRef.current = el; restoreScroll(el); }}>
              <Stack gap="4">
                <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                  {fact("Поставщик", d.supplier ?? "—")}
                  {fact("Дата отгрузки", dateTime(d.createdAt))}
                  {fact("Пришла в систему", dateTime(d.receivedAt))}
                  {fact("Одобрил(а)", d.approvedBy ? `${d.approvedBy} · ${d.approvedAt ? dateTime(d.approvedAt) : ""}` : "—",
                    d.approvalComment)}
                  {fact(d.status === "REJECTED" ? "Отклонил(а)" : "Принял(а)",
                    d.acceptedBy ? `${d.acceptedBy} · ${d.acceptedAt ? dateTime(d.acceptedAt) : ""}` : "автоприёмка",
                    d.rejectComment)}
                  {fact("Сумма", invoiceKop
                    ? (acceptedKop !== invoiceKop ? `${money(acceptedKop)} из ${money(invoiceKop)} по накладной` : money(invoiceKop))
                    : "без сумм", null)}
                </SimpleGrid>

                <Box>
                  <Text textStyle="sm" fontWeight="semibold" mb="2">
                    Позиции · принято {acceptedLines} из {d.lines.length}
                  </Text>
                  <Stack gap="2">
                    {d.lines.map((l) => {
                      const short = l.qtyActual != null && l.qtyActual < l.qtyInvoice;
                      return (
                        <Box key={l.lineNo} borderWidth="1px" rounded="md" p="3"
                             borderColor={l.rejectReason ? "orange.muted" : undefined}>
                          <Flex justify="space-between" gap="2" wrap="wrap" rowGap="1">
                            <Text fontWeight="medium">{l.name}</Text>
                            {l.batchId && (
                              <Button size="2xs" variant="surface" onClick={() => {
                                // Окно не закрываем: поставка остаётся в адресе, «Назад» вернёт сюда же.
                                sessionStorage.setItem(scrollKey, String(bodyRef.current?.scrollTop ?? 0));
                                navigate(`/${loc}/batches/${l.batchId}`);
                              }}
                                      title="Открыть партию на складе">
                                <Text as="span" fontFamily="mono" fontWeight="semibold">{l.batchLabel}</Text>
                                {l.batchLeftText && <Text as="span">· осталось {l.batchLeftText}</Text>}
                                <LuChevronRight />
                              </Button>
                            )}
                          </Flex>
                          <SimpleGrid columns={{ base: 2, sm: 4 }} gap="2" mt="2">
                            {fact("Накладная", l.qtyText)}
                            {fact("Одобрено", l.approvedQtyText ?? "всё")}
                            {fact("Принято", <Text as="span" color={short ? "orange.fg" : undefined}>{l.qtyActualText ?? "—"}</Text>)}
                            {fact("Годна до", dateTime(l.expiresAt))}
                          </SimpleGrid>
                          {(l.rejectReason || l.approveNote || l.rejectComment) && (
                            <Text textStyle="xs" color="orange.fg" mt="2">
                              {l.rejectReason ? REASONS[l.rejectReason] : ""}
                              {l.approveNote ? `${l.rejectReason ? " · " : ""}управляющий: «${l.approveNote}»` : ""}
                              {l.rejectComment ? ` · «${l.rejectComment}»` : ""}
                            </Text>
                          )}
                          {l.costKop != null && (
                            <Text textStyle="xs" color="fg.muted" mt="1">по накладной {money(l.costKop)}</Text>
                          )}
                        </Box>
                      );
                    })}
                  </Stack>
                </Box>

                {d.hasInvoicePhoto && (
                  <Box>
                    <Text textStyle="sm" fontWeight="semibold" mb="2">Фото накладной{d.invoicePhotoCount > 1 ? ` · ${d.invoicePhotoCount}` : ""}</Text>
                    <PhotoStrip srcs={Array.from({ length: d.invoicePhotoCount || 1 }, (_, i) => api.invoicePhotoUrl(loc, d.id, i))}
                                        alt={`Накладная ${d.number}`} size="24" max={6} />
                  </Box>
                )}

                {!!returns.data?.length && (
                  <Box>
                    <Text textStyle="sm" fontWeight="semibold" mb="2">Возвраты поставщику по этой поставке</Text>
                    <Stack gap="2">
                      {returns.data.map((r) => (
                        <Box key={r.id} borderWidth="1px" rounded="md" p="2.5">
                          <Flex justify="space-between" gap="2" wrap="wrap" rowGap="1">
                            <Text textStyle="sm" fontWeight="medium">{r.reasonText}{r.comment ? ` — ${r.comment}` : ""}</Text>
                            <Badge size="sm" colorPalette={r.status === "PENDING" ? "orange" : r.status === "EXECUTED" ? "gray" : "red"}>
                              {r.status === "PENDING" ? "ждёт подтверждения" : r.status === "EXECUTED" ? "возвращено" : "отклонено"}
                            </Badge>
                          </Flex>
                          <Text textStyle="xs" color="fg.muted">
                            {r.lines.map((l) => `${l.productName} ${l.qtyText}`).join(", ")} · {money(r.costKop)}
                          </Text>
                          <Text textStyle="xs" color="fg.muted">
                            {r.createdByName} · {dateTime(r.createdAt)}{r.decidedByName ? ` · решил(а) ${r.decidedByName}` : ""}
                          </Text>
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              {canReturn && RETURNABLE.includes(d.status) && (
                <Button colorPalette="teal" variant="outline" me="auto" onClick={() => setReturning(true)}>
                  <LuUndo2 /> Оформить возврат
                </Button>
              )}
              <Button variant="outline" onClick={onClose}>Закрыть</Button>
            </Dialog.Footer>
            <ReturnDialog open={returning} onClose={() => setReturning(false)} deliveryId={d.id} />
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function ExpiryBadge({ status, hours }: { status: BatchStatus; hours: number }) {
  return (
    <Badge colorPalette={BATCH[status].palette} variant="subtle" whiteSpace="nowrap">
      {status === "EXPIRED" ? "просрочено" : `${BATCH[status].label} · ${timeLeft(hours)}`}
    </Badge>
  );
}

function LineHead({ l }: { l: DeliveryDto["lines"][number] }) {
  return (
    <Box flex="1" minW="44">
      <Text fontWeight="medium">{l.name}</Text>
      <HStack gap="2" wrap="wrap" mt="0.5">
        <ExpiryBadge status={l.expiryStatus} hours={l.hoursLeft} />
        <Text textStyle="xs" color="fg.muted" whiteSpace="nowrap">годна до {dateTime(l.expiresAt)}</Text>
        {l.costKop != null && <Text textStyle="xs" color="fg.muted" whiteSpace="nowrap">{money(l.costKop)}</Text>}
      </HStack>
    </Box>
  );
}

function RejectDialog({ d, open, onClose }: { d: DeliveryDto; open: boolean; onClose: () => void }) {
  const { loc } = useSession();
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const reject = async () => {
    try {
      await api.rejectDelivery(loc, d.id, comment);
      notifyOk(`Поставка ${d.number} отклонена`);
      onClose();
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Отклонить поставку {d.number}?</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              <Field.Root>
                <Field.Label>Причина</Field.Label>
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)}
                          placeholder="Не заказывали, привезли не то, машина без холодильника…" />
              </Field.Root>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button colorPalette="red" onClick={reject}>Отклонить</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─── Шаг 1. Управляющий одобряет ───────────────────────────────────────────

interface Decision {
  qty: string;
  note: string;
}

/** Управляющий решает, что из накладной берём: по строке — сколько (0 — не берём) и почему меньше. */
function ApprovalCard({ d }: { d: DeliveryDto }) {
  const { loc } = useSession();
  const qc = useQueryClient();
  // Просроченное всё равно не принять (кроме тестовой поставки) — сразу предлагаем не брать.
  const [dec, setDec] = useState<Record<number, Decision>>(() => Object.fromEntries(d.lines
    .filter((l) => l.expiryStatus === "EXPIRED" && !d.mock)
    .map((l) => [l.lineNo, { qty: "0", note: "просрочено" }])));
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const qtyOf = (lineNo: number, invoice: number) => {
    const v = dec[lineNo]?.qty;
    return v === undefined || v === "" ? invoice : Number(v);
  };
  const set = (lineNo: number, patch: Partial<Decision>) =>
    setDec({ ...dec, [lineNo]: { ...(dec[lineNo] ?? { qty: "", note: "" }), ...patch } });
  const taken = d.lines.filter((l) => qtyOf(l.lineNo, l.qtyInvoice) > 0);
  const cut = d.lines.some((l) => qtyOf(l.lineNo, l.qtyInvoice) < l.qtyInvoice);
  const tooMuch = d.lines.some((l) => qtyOf(l.lineNo, l.qtyInvoice) > l.qtyInvoice);

  const approve = async () => {
    setBusy(true);
    try {
      await api.approveDelivery(loc, d.id, d.lines.map((l) => ({ lineNo: l.lineNo,
        qty: dec[l.lineNo]?.qty === undefined || dec[l.lineNo]?.qty === "" ? null : Number(dec[l.lineNo].qty),
        note: dec[l.lineNo]?.note || undefined })), comment);
      notifyOk(cut ? `Поставка ${d.number} одобрена частично` : `Поставка ${d.number} одобрена`, "Теперь её принимает кладовщик");
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section borderColor="purple.muted" title={<HStack wrap="wrap" as="span">Поставка {d.number} <Badge colorPalette="purple">ждёт вашего одобрения</Badge>
      {d.mock && <Badge colorPalette="purple" variant="outline"><LuFlaskConical /> тестовая</Badge>}</HStack>}
             actions={<Text textStyle="sm" color="fg.muted">{d.supplier} · создана {dateTime(d.createdAt)}</Text>}>
      <Text textStyle="sm" color="fg.muted" mb="3">
        Решите, что из накладной берём. Можно взять всё, часть строки или не брать строку совсем — кладовщик примет не больше одобренного.
      </Text>
      <Stack gap="0" divideY="1px">
        {d.lines.map((l) => {
          const q = qtyOf(l.lineNo, l.qtyInvoice);
          const unit = l.unit === "PCS" ? "шт" : l.unit === "ML" ? "мл" : "г";
          return (
            <Box key={l.lineNo} py="3" px="2" mx="-2" rounded="sm" bg={q === 0 ? "bg.muted" : q < l.qtyInvoice ? "purple.subtle" : undefined}>
              <Flex gap="3" wrap="wrap" align="center">
                <LineHead l={l} />
                <Box textAlign="end" minW="20">
                  <Text textStyle="xs" color="fg.muted">в накладной</Text>
                  <Text whiteSpace="nowrap">{l.qtyText}</Text>
                </Box>
                <Field.Root w={{ base: "28", md: "36" }} invalid={q > l.qtyInvoice}>
                  <Field.Label textStyle="xs" color="fg.muted">берём, {unit}</Field.Label>
                  <Input size="sm" type="number" min={0} max={l.qtyInvoice} placeholder={String(l.qtyInvoice)} value={dec[l.lineNo]?.qty ?? ""}
                         onChange={(e) => set(l.lineNo, { qty: e.target.value })} />
                  <Field.HelperText mt="0.5">= {qty(q, l.unit)}</Field.HelperText>
                </Field.Root>
                <HStack gap="1">
                  <Button size="xs" variant={q === l.qtyInvoice ? "subtle" : "ghost"} onClick={() => set(l.lineNo, { qty: "" })}>всё</Button>
                  <Button size="xs" variant={q === 0 ? "subtle" : "ghost"} colorPalette="red" onClick={() => set(l.lineNo, { qty: "0" })}>не берём</Button>
                </HStack>
              </Flex>
              {q < l.qtyInvoice && (
                <Input size="sm" mt="2" placeholder="Почему меньше (увидит кладовщик и поставщик)" value={dec[l.lineNo]?.note ?? ""}
                       onChange={(e) => set(l.lineNo, { note: e.target.value })} />
              )}
            </Box>
          );
        })}
      </Stack>
      <Textarea mt="3" rows={2} placeholder="Комментарий для кладовщика (необязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <Flex mt="3" gap="3" align="center" wrap="wrap">
        <Text textStyle="sm" color="fg.muted" flex="1" minW="48">
          {taken.length === 0 ? "Не берём ничего — тогда поставку лучше отклонить"
            : cut ? `Берём ${taken.length} из ${d.lines.length} ${plural(d.lines.length, ["строки", "строк", "строк"])}, часть — не полностью` : "Берём всё как в накладной"}
        </Text>
        <Button variant="outline" colorPalette="red" size="sm" onClick={() => setRejectOpen(true)}>Отклонить</Button>
        <Button colorPalette="purple" loading={busy} disabled={taken.length === 0 || tooMuch} onClick={approve}>
          {cut ? "Одобрить частично" : "Одобрить"}
        </Button>
      </Flex>
      <RejectDialog d={d} open={rejectOpen} onClose={() => setRejectOpen(false)} />
    </Section>
  );
}

/** Кладовщик видит, что поставка пришла, но принимать её рано — ждёт решения управляющего. */
/** Поставка, по которой этой роли действовать не нужно: ждёт решения управляющего или приёмки у двери. */
function WaitingApproval({ d, badge = "ждёт одобрения управляющего", palette = "purple",
  text = "Принимать пока рано: управляющий решит, что из накладной берём." }: {
  d: DeliveryDto; badge?: string; palette?: string; text?: string;
}) {
  return (
    <Section title={<HStack wrap="wrap" as="span">Поставка {d.number} <Badge colorPalette={palette}>{badge}</Badge></HStack>}
             actions={<Text textStyle="sm" color="fg.muted">{d.supplier} · создана {dateTime(d.createdAt)}</Text>}>
      <Text textStyle="sm" color="fg.muted" mb="2">{text}</Text>
      <Stack gap="1">
        {d.lines.map((l) => (
          <HStack key={l.lineNo} justify="space-between" gap="3" wrap="wrap" textStyle="sm">
            <HStack gap="2" wrap="wrap" minW="0"><Text>{l.name}</Text><ExpiryBadge status={l.expiryStatus} hours={l.hoursLeft} /></HStack>
            <Text whiteSpace="nowrap" color="fg.muted">{l.qtyText}</Text>
          </HStack>
        ))}
      </Stack>
    </Section>
  );
}

// ─── Шаг 2. Кладовщик принимает по факту ───────────────────────────────────

interface Fact {
  qty: string;
  reason: RejectReason | "";
  comment: string;
}

function PendingDelivery({ d }: { d: DeliveryDto }) {
  const { loc, me } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const allowedOf = (l: DeliveryDto["lines"][number]) => l.approvedQty ?? l.qtyInvoice;
  // Просроченную строку сразу предлагаем не принимать: принять её всё равно нельзя (кроме тестовой поставки).
  const [facts, setFacts] = useState<Record<number, Fact>>(() => Object.fromEntries(d.lines
    .filter((l) => l.expiryStatus === "EXPIRED" && !d.mock && allowedOf(l) > 0)
    .map((l) => [l.lineNo, { qty: "0", reason: "EXPIRED" as RejectReason, comment: "" }])));
  // Фото накладной — можно несколько (страницы, обороты, пломбы); лимита «5 МБ» нет.
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const selfApproved = d.approvedById != null && d.approvedById === me?.id;

  const factOf = (l: DeliveryDto["lines"][number]) => {
    const f = facts[l.lineNo];
    return f && f.qty !== "" ? Number(f.qty) : allowedOf(l);
  };
  const setFact = (lineNo: number, patch: Partial<Fact>) =>
    setFacts({ ...facts, [lineNo]: { ...(facts[lineNo] ?? { qty: "", reason: "", comment: "" }), ...patch } });
  const open = d.lines.filter((l) => allowedOf(l) > 0);
  const short = open.filter((l) => factOf(l) < allowedOf(l));
  const over = open.filter((l) => allowedOf(l) < l.qtyInvoice && factOf(l) > allowedOf(l));
  const accepted = open.filter((l) => factOf(l) > 0);
  const missingReason = short.some((l) => !facts[l.lineNo]?.reason);

  const accept = async (confirmShortLife = false) => {
    setBusy(true);
    try {
      if (photos.length) await api.invoicePhoto(loc, d.id, photos);
      const lines = open.map((l) => {
        const f = facts[l.lineNo];
        const q = factOf(l);
        return { lineNo: l.lineNo, qtyActual: f && f.qty !== "" ? q : null,
          rejectReason: q < allowedOf(l) ? (f?.reason || "SHORTAGE") as RejectReason : null, comment: f?.comment || undefined };
      });
      const r = await api.acceptDelivery(loc, d.id, lines, confirmShortLife);
      notifyOk(r.status === "PARTIAL" ? `Поставка ${d.number} принята частично` : `Поставка ${d.number} принята`,
        r.batchIds.length ? "Партии созданы, сроки зафиксированы. Распечатайте этикетки в карточках партий." : undefined);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
      if (r.batchIds.length) navigate(`/${loc}/stock`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 428 && window.confirm(`${e.message}. Принять всё равно?`)) {
        await accept(true);
      } else if (!(e instanceof ApiError && e.status === 428)) {
        notifyError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={<HStack wrap="wrap" as="span">Поставка {d.number} <Badge colorPalette="blue">одобрена — примите по факту</Badge>
      {d.mock && <Badge colorPalette="purple"><LuFlaskConical /> тестовая</Badge>}</HStack>}
             actions={<Text textStyle="sm" color="fg.muted">{d.supplier} · создана {dateTime(d.createdAt)}</Text>}>
      <Box mb="3" p="2.5" rounded="md" bg="blue.subtle" textStyle="sm">
        Одобрил {d.approvedBy ?? "система"}{d.approvedAt ? ` · ${dateTime(d.approvedAt)}` : ""}
        {d.approvalComment && <Text as="span" fontWeight="medium"> — «{d.approvalComment}»</Text>}
      </Box>
      {selfApproved && (
        <Text textStyle="sm" color="orange.fg" mb="3">Вы одобрили эту поставку — принимает другой сотрудник (кладовщик). Так одному человеку не провести поставку целиком.</Text>
      )}
      {d.mock && (
        <Text textStyle="sm" color="purple.fg" mb="3">
          Тестовая поставка задним числом: просроченные строки примутся и сразу встанут «под списание» — так проверяют списание просрочки.
        </Text>
      )}
      <Stack gap="0" divideY="1px">
        {d.lines.map((l) => {
          const allowed = allowedOf(l);
          if (allowed === 0) {
            return (
              <Box key={l.lineNo} py="3" px="2" mx="-2" rounded="sm" bg="bg.muted" opacity={0.75}>
                <Flex gap="3" wrap="wrap" align="center">
                  <LineHead l={l} />
                  <Badge colorPalette="gray">не одобрено{l.approveNote ? ` — ${l.approveNote}` : ""}</Badge>
                </Flex>
              </Box>
            );
          }
          const f = facts[l.lineNo];
          const q = factOf(l);
          const isShort = q < allowed;
          const blocked = l.expiryStatus === "EXPIRED" && !d.mock;
          const cutByManager = allowed < l.qtyInvoice;
          return (
            <Box key={l.lineNo} py="3" bg={isShort ? "orange.subtle" : undefined} px="2" mx="-2" rounded="sm">
              <Flex gap="3" wrap="wrap" align="center">
                <LineHead l={l} />
                <Box textAlign="end" minW="20">
                  <Text textStyle="xs" color="fg.muted">{cutByManager ? "одобрено" : "по накладной"}</Text>
                  <Text whiteSpace="nowrap">{cutByManager ? l.approvedQtyText : l.qtyText}</Text>
                  {cutByManager && <Text textStyle="xs" color="fg.muted" whiteSpace="nowrap">из {l.qtyText}</Text>}
                </Box>
                <Field.Root w={{ base: "28", md: "36" }} invalid={cutByManager && q > allowed}>
                  <Field.Label textStyle="xs" color="fg.muted">факт</Field.Label>
                  <Input size="sm" type="number" min={0} max={cutByManager ? allowed : undefined} placeholder={String(allowed)}
                         value={f?.qty ?? ""} disabled={blocked} onChange={(e) => setFact(l.lineNo, { qty: e.target.value })} />
                  <Field.HelperText mt="0.5">= {qty(q, l.unit)}</Field.HelperText>
                </Field.Root>
                {!blocked && (
                  <IconButton aria-label="Не принимать строку" size="sm" variant="ghost" title="Не принимать строку"
                              onClick={() => setFact(l.lineNo, { qty: "0" })}><LuX /></IconButton>
                )}
              </Flex>
              {cutByManager && l.approveNote && <Text textStyle="xs" color="fg.muted" mt="1">Управляющий: {l.approveNote}</Text>}
              {blocked && (
                <Text textStyle="xs" color="red.fg" mt="1">Срок уже истёк — принять нельзя. Строка не будет принята с причиной «просрочено».</Text>
              )}
              {isShort && !blocked && (
                <Flex gap="2" mt="2" wrap="wrap">
                  <Choice size="sm" w={{ base: "full", sm: "48" }} label="Почему меньше" placeholder="Почему меньше?"
                          value={f?.reason ?? ""} onChange={(v) => setFact(l.lineNo, { reason: v as RejectReason })}
                          options={DOOR_REASONS.map((k) => ({ value: k, label: REASONS[k] }))} />
                  <Input size="sm" flex="1" minW="40" placeholder="Комментарий (необязательно)" value={f?.comment ?? ""}
                         onChange={(e) => setFact(l.lineNo, { comment: e.target.value })} />
                </Flex>
              )}
            </Box>
          );
        })}
      </Stack>
      <Box mt="4">
        <Text textStyle="sm" fontWeight="medium" mb="1.5"><LuCamera style={{ display: "inline", verticalAlign: "-2px" }} /> Фото накладной</Text>
        <PhotoPicker files={photos} onChange={setPhotos} label="фото накладной" />
      </Box>
      <Flex mt="4" gap="3" align="center" wrap="wrap">
        <Text textStyle="sm" color="fg.muted" flex="1" minW="48">
          {short.length > 0 ? `Недовоз: ${short.length} ${plural(short.length, ["строка", "строки", "строк"])} меньше одобренного`
            : "Всё как одобрено"}
        </Text>
        <Button variant="outline" colorPalette="red" size="sm" onClick={() => setRejectOpen(true)}>Отклонить</Button>
        <Button colorPalette="teal" loading={busy} disabled={selfApproved || missingReason || over.length > 0 || accepted.length === 0}
                title={selfApproved ? "Принимает другой сотрудник" : missingReason ? "Укажите, почему принято меньше" : undefined}
                onClick={() => accept(false)}>
          {short.length ? "Принять частично" : "Принять"}
        </Button>
      </Flex>
      <RejectDialog d={d} open={rejectOpen} onClose={() => setRejectOpen(false)} />
    </Section>
  );
}

// ─── Новая поставка: форма → тот же API, что у внешних систем ─────────────

type ShelfMode = "h" | "d" | "date";

interface Line {
  productId: string;      // "" — не выбран, "__new" — новый продукт
  newName: string;
  newUnit: string;
  qty: string;
  shelf: string;
  mode: ShelfMode;
  until: string;          // «годна до», МСК
  cost: string;
}

const EMPTY: Line = { productId: "", newName: "", newUnit: "G", qty: "", shelf: "", mode: "h", until: "", cost: "" };

/** Даты в форме — по Москве, как во всём интерфейсе, а не по часовому поясу браузера. */
const MSK = 3 * 3_600_000;
const toMskInput = (ms: number) => new Date(ms + MSK).toISOString().slice(0, 16);
const fromMskInput = (v: string) => new Date(Date.parse(`${v}:00Z`) - MSK).toISOString();

const TRANSLIT: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const slug = (s: string) => s.toLowerCase().split("").map((c) => TRANSLIT[c] ?? (/[a-z0-9]/.test(c) ? c : "_")).join("")
  .replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `p${Date.now() % 100000}`;

const UNIT_LABEL: Record<string, string> = { G: "г", ML: "мл", PCS: "шт" };

function NewDelivery({ onDone }: { onDone: () => void }) {
  const { loc, config } = useSession();
  const qc = useQueryClient();
  const now = useServerNow();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, staleTime: 60_000 });
  const raw = (catalog.data?.products ?? []).filter((p) => p.kind === "RAW");
  const [number, setNumber] = useState("");
  const [supplier, setSupplier] = useState("");
  const [created, setCreated] = useState(() => toMskInput(now));
  const [mock, setMock] = useState(false);
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }]);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => j === i ? { ...l, ...patch } : l));
  const createdMs = Date.parse(fromMskInput(created));
  const backdated = now - createdMs > 3_600_000;
  const product = (l: Line): CatalogProduct | undefined => raw.find((x) => x.id === l.productId);
  const ready = (l: Line) => (l.productId === "__new" ? l.newName.trim() : l.productId) && Number(l.qty) > 0
    && (l.mode === "date" ? !!l.until : Number(l.shelf || product(l)?.shelfLifeHours || 0) > 0);
  const filled = lines.filter(ready);

  /** Когда истечёт строка — та же логика, что у сервера: дата создания + срок, либо явная дата. */
  const expiresOf = (l: Line): number | null => {
    if (l.mode === "date") return l.until ? Date.parse(fromMskInput(l.until)) : null;
    const h = Number(l.shelf || (l.mode === "h" ? product(l)?.shelfLifeHours : null) || 0) * (l.mode === "d" ? 24 : 1);
    return h > 0 ? createdMs + h * 3_600_000 : null;
  };

  const submit = async () => {
    setBusy(true);
    try {
      const body: DeliveryIn = {
        id: `FORM-${Date.now()}`,
        number: number.trim() || `Р-${Date.now() % 100000}`,
        createdAt: fromMskInput(created),
        supplier: supplier.trim() || null,
        mock: mock || undefined,
        lines: filled.map((l) => {
          const p = product(l);
          const name = p?.name ?? l.newName.trim();
          const shelfHours = l.mode === "date" ? null
            : Number(l.shelf || p?.shelfLifeHours || 72) * (l.mode === "d" ? 24 : 1);
          return { productId: p?.id ?? slug(name), name, unit: p?.unit ?? l.newUnit, qty: Number(l.qty),
            shelfLifeHours: shelfHours, expiresAt: l.mode === "date" ? fromMskInput(l.until) : null,
            costKop: l.cost ? Math.round(Number(l.cost) * 100) : null };
        }),
      };
      await api.createDelivery(loc, body);
      notifyOk("Поставка создана — теперь её нужно принять", backdated ? "Создана задним числом: сроки посчитаны от указанной даты" : undefined);
      setLines([{ ...EMPTY }]);
      qc.invalidateQueries({ queryKey: ["deliveries", loc] });
      qc.invalidateQueries({ queryKey: ["catalog"] });
      onDone();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Новая поставка" actions={<Text textStyle="xs" color="fg.muted">Форма ходит в тот же API, что и внешние системы</Text>}>
      <SimpleGrid columns={{ base: 1, md: 3 }} gap="3" mb="2">
        <Field.Root><Field.Label>Номер</Field.Label><Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="П-42" /></Field.Root>
        <Field.Root><Field.Label>Поставщик</Field.Label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="ООО «Ромашка»" /></Field.Root>
        <Field.Root>
          <Field.Label>Дата создания, МСК</Field.Label>
          <Input type="datetime-local" value={created} max={toMskInput(now + 86_400_000)} onChange={(e) => setCreated(e.target.value)} />
        </Field.Root>
      </SimpleGrid>
      <HStack gap="1.5" mb="3" wrap="wrap">
        <Text textStyle="xs" color="fg.muted">Задним числом:</Text>
        {[0, 1, 3, 7].map((days) => (
          <Button key={days} size="2xs" variant="outline" onClick={() => setCreated(toMskInput(now - days * 86_400_000))}>
            {days === 0 ? "сейчас" : `−${days}${NB}${plural(days, ["день", "дня", "дней"])}`}
          </Button>
        ))}
        {backdated && <Badge colorPalette="orange">сроки считаются от {dateTime(createdMs)}</Badge>}
      </HStack>
      {config?.demoMode && (
        <Checkbox.Root checked={mock} onCheckedChange={(e) => setMock(!!e.checked)} mb="3" colorPalette="purple" alignItems="flex-start">
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>
            Тестовая поставка — разрешить принять уже просроченное
            <Text textStyle="xs" color="fg.muted" fontWeight="normal">Только в демо: просроченные строки встанут «под списание», чтобы проверить списание просрочки человеком</Text>
          </Checkbox.Label>
        </Checkbox.Root>
      )}
      <Stack gap="3">
        {lines.map((l, i) => {
          const p = product(l);
          const unit = p?.unit ?? l.newUnit;
          const exp = expiresOf(l);
          const total = exp ? exp - createdMs : 0;
          const left = exp ? (exp - now) / 3_600_000 : 0;
          const status: BatchStatus | null = !exp ? null : left <= 0 ? "EXPIRED"
            : left * 3_600_000 <= total * 0.1 ? "CRITICAL" : left * 3_600_000 <= total * 0.25 ? "SOON" : "FRESH";
          return (
            <Box key={i} p="3" borderWidth="1px" rounded="md">
              <Flex gap="2" wrap="wrap" align="end">
                <Box flex="2" minW="48">
                  <SearchSelect value={l.productId} onChange={(v) => set(i, { productId: v })} placeholder="Продукт…"
                                options={[{ value: "__new", label: "+ Новый продукт" },
                                  ...raw.map((p) => ({ value: p.id, label: p.name, hint: p.category ?? undefined, group: "Сырьё" }))]} />
                </Box>
                {l.productId === "__new" && (
                  <>
                    <Input flex="2" minW="40" placeholder="Название" value={l.newName} onChange={(e) => set(i, { newName: e.target.value })} />
                    <Choice w="32" label="Единица" value={l.newUnit} onChange={(v) => set(i, { newUnit: v })}
                            options={[{ value: "G", label: "граммы" }, { value: "ML", label: "мл" }, { value: "PCS", label: "штуки" }]} />
                  </>
                )}
                <Input flex="1" minW="28" type="number" placeholder={`кол-во, ${UNIT_LABEL[unit]}`} value={l.qty}
                       onChange={(e) => set(i, { qty: e.target.value })} />
                <HStack flex="1.5" minW="52" gap="1">
                  {l.mode === "date"
                    ? <Input type="datetime-local" value={l.until} onChange={(e) => set(i, { until: e.target.value })} />
                    : <Input type="number" placeholder={p?.shelfLifeHours && l.mode === "h" ? `срок ${p.shelfLifeHours}` : "срок"}
                             value={l.shelf} onChange={(e) => set(i, { shelf: e.target.value })} />}
                  <Choice w="32" flexShrink={0} label="Срок в" value={l.mode} onChange={(v) => set(i, { mode: v as ShelfMode })}
                          options={[{ value: "h", label: "часов" }, { value: "d", label: "дней" }, { value: "date", label: "до даты" }]} />
                </HStack>
                <Input flex="1" minW="24" type="number" placeholder="сумма, ₽" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} />
                <IconButton aria-label="Удалить строку" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}
                            disabled={lines.length === 1}><LuTrash2 /></IconButton>
              </Flex>
              {status && exp && (
                <HStack mt="2" gap="2" wrap="wrap">
                  <ExpiryBadge status={status} hours={left} />
                  <Text textStyle="xs" color="fg.muted">годна до {dateTime(exp)}</Text>
                  {status === "EXPIRED" && !mock && <Text textStyle="xs" color="red.fg">— принять не получится</Text>}
                </HStack>
              )}
            </Box>
          );
        })}
      </Stack>
      <Flex mt="3" gap="2" align="center" wrap="wrap">
        <Button variant="outline" size="sm" onClick={() => setLines([...lines, { ...EMPTY }])}><LuPlus /> Строка</Button>
        <Box flex="1" />
        {filled.length > 0 && (
          <Text textStyle="sm" color="fg.muted" order={{ base: -1, md: 0 }} flexBasis={{ base: "full", md: "auto" }}>
            {filled.length}{NB}{plural(filled.length, ["строка", "строки", "строк"])} ·{" "}
            {filled.map((l) => qty(Number(l.qty), product(l)?.unit ?? l.newUnit)).join(", ")}
          </Text>
        )}
        <Button variant="ghost" onClick={onDone}>Отмена</Button>
        <Button colorPalette="teal" loading={busy} onClick={submit} disabled={!filled.length}>Создать поставку</Button>
      </Flex>
    </Section>
  );
}

// ─── Файл XML / JSON ───────────────────────────────────────────────────────

function UploadButton() {
  const { loc } = useSession();
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const r = await api.uploadDelivery(loc, file);
      notifyOk(r.duplicate ? `Поставка ${r.id} уже загружена` : `Поставка ${r.id} загружена — примите её`,
        r.duplicate ? "Повтор того же документа склад не задваивает" : undefined);
      qc.invalidateQueries({ queryKey: ["deliveries", loc] });
      qc.invalidateQueries({ queryKey: ["catalog"] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" loading={busy} onClick={() => ref.current?.click()}><LuFileUp /> Загрузить файл</Button>
      <input ref={ref} hidden type="file"
             accept=".xlsx,.xml,.json,application/json,application/xml,text/xml,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
             onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
    </>
  );
}

/** Пример файла из настоящего каталога: его можно сразу загрузить обратно. */
function SampleMenu() {
  const { loc } = useSession();
  const now = useServerNow();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, staleTime: 60_000 });
  const raw = (catalog.data?.products ?? []).filter((p) => p.kind === "RAW").slice(0, 2);
  const sample = () => {
    const id = `SUP-${new Date(now).toISOString().slice(0, 10)}-${Math.floor(Math.random() * 900 + 100)}`;
    const created = new Date(now).toISOString().replace(/\.\d+Z$/, "Z");
    const lines = (raw.length ? raw : [{ id: "milk", name: "Молоко", unit: "ML", shelfLifeHours: 72 } as CatalogProduct])
      .map((p) => ({ productId: p.id, name: p.name, unit: p.unit, qty: p.unit === "PCS" ? 10 : 2000,
        shelfLifeHours: p.shelfLifeHours ?? 72, costKop: 50_000 }));
    return { id, number: `П-${id.slice(-3)}`, createdAt: created, supplier: "ООО «Ромашка»", lines };
  };
  const download = (name: string, text: string, type: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button size="sm" variant="ghost"><LuDownload /> Пример файла</Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content>
            <Menu.Item value="xlsx" asChild>
              <a href={api.deliverySampleXlsxUrl(loc)} download="delivery-sample.xlsx">Excel (.xlsx) — заполнить и загрузить</a>
            </Menu.Item>
            <Menu.Item value="json" onClick={() => {
              const s = sample();
              download(`${s.id}.json`, JSON.stringify(s, null, 2), "application/json");
            }}>JSON</Menu.Item>
            <Menu.Item value="xml" onClick={() => {
              const s = sample();
              const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<delivery id="${esc(s.id)}" number="${esc(s.number)}" createdAt="${s.createdAt}" supplier="${esc(s.supplier)}">\n`
                + s.lines.map((l) => `  <line productId="${esc(l.productId)}" name="${esc(l.name)}" unit="${l.unit}" qty="${l.qty}" shelfLifeHours="${l.shelfLifeHours}" costKop="${l.costKop}"/>`).join("\n")
                + "\n</delivery>\n";
              download(`${s.id}.xml`, xml, "application/xml");
            }}>XML</Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
