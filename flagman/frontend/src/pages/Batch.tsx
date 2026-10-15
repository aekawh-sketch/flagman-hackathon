import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  Badge, Box, Button, Checkbox, Dialog, Field, Grid, HStack, Input, Portal, QrCode, Stack, Table, Text, Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuArrowLeft, LuBan, LuPackageOpen, LuPrinter, LuTrash2, LuUndo2 } from "react-icons/lu";
import { api } from "../api";
import { useServerNow, useSession } from "../session";
import { dateTime, dateTimeYear, hoursBetween, money, ORDER_STATUS } from "../format";
import { Countdown, Empty, LifeBar, Loading, PageHeader, Section, StatusBadge } from "../components/ui";
import { WriteoffDialog } from "../components/WriteoffDialog";
import { notifyError, notifyOk } from "../components/Toaster";
import { BatchDishes } from "./Trace";

export function BatchPage() {
  const { loc, can } = useSession();
  const { id } = useParams();
  const batchId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const now = useServerNow();
  const trace = useQuery({ queryKey: ["trace", loc, batchId], queryFn: () => api.trace(loc, batchId) });
  const batches = useQuery({ queryKey: ["batches", loc, trace.data?.productId, "all"], enabled: !!trace.data,
    queryFn: () => api.batches(loc, trace.data!.productId, true) });
  const batch = batches.data?.find((b) => b.id === batchId) ?? null;
  const [writeoff, setWriteoff] = useState(false);
  const [label, setLabel] = useState(false);
  const [block, setBlock] = useState(false);
  const [packs, setPacks] = useState("1");

  const refresh = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifyOk(ok);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  if (trace.isLoading) return <Loading rows={6} />;
  if (!trace.data) {
    return <Empty title="Партия не найдена"
                  description="Если открыли по QR — этикетку могли напечатать на другом складе: номера партий у каждого склада свои." />;
  }
  const t = trace.data;
  const hours = batch ? hoursBetween(now, batch.expiresAt) : 0;

  return (
    <>
      <Button variant="ghost" size="sm" mb="2" onClick={() => navigate(-1)}><LuArrowLeft /> Назад</Button>
      <PageHeader title={`${t.productName} · партия ${t.label}`}
        subtitle={t.supplier ? `Поставка ${t.deliveryNumber} от «${t.supplier}»` : sourceText(t.source, t.parentBatchId)}
        actions={batch && (
          <>
            <Button size="sm" variant="outline" onClick={() => setLabel(true)}><LuPrinter /> Этикетка</Button>
            {/* Списать можно только свободное: то, что уже под заявкой, ждёт решения управляющего. */}
            {can("COOK", "STOREKEEPER", "MANAGER") && batch.qtyLeft - batch.held > 0 && !batch.blocked && (
              <Button size="sm" variant="outline" colorPalette="red" onClick={() => setWriteoff(true)}>
                <LuTrash2 /> Списать
              </Button>
            )}
            {can("MANAGER") && !batch.blocked && batch.qtyLeft > 0 && (
              <Button size="sm" variant="outline" onClick={() => setBlock(true)}><LuBan /> Отзыв / блокировка</Button>
            )}
            {can("MANAGER") && batch.blocked && (
              <>
                <Button size="sm" variant="outline" onClick={() => act(() => api.unblockBatch(loc, batchId, "Ложная тревога"), "Разблокировано")}>
                  <LuUndo2 /> Разблокировать
                </Button>
                {batch.qtyLeft > 0 && (
                  <Button size="sm" colorPalette="red" onClick={() => act(() => api.disposeBatch(loc, batchId, false), "Списано по отзыву")}>
                    Списать по отзыву
                  </Button>
                )}
              </>
            )}
          </>
        )} />

      {batch && (
        <Grid templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }} gap="3" mb="4">
          <Box p="4" borderWidth="1px" rounded="md" bg="bg.panel">
            <Text textStyle="xs" color="fg.muted">Остаток</Text>
            {/* Сколько осталось из принятого: «100 кг / 200 кг» — вторая часть тише, главное — остаток */}
            <Text textStyle="xl" fontWeight="semibold">
              {batch.qtyText}
              <Text as="span" fontWeight="normal" color="fg.muted"> / {batch.qtyInitialText}</Text>
            </Text>
            {batch.held > 0 && <Text textStyle="xs" color="orange.fg">под заявкой на списание</Text>}
          </Box>
          <Box p="4" borderWidth="1px" rounded="md" bg="bg.panel">
            <Text textStyle="xs" color="fg.muted">Годна до</Text>
            <Text textStyle="xl" fontWeight="semibold">{dateTimeYear(batch.expiresAt)}</Text>
            <Text textStyle="xs" color="fg.muted">срок зафиксирован при приёмке и не меняется</Text>
          </Box>
          <Box p="4" borderWidth="1px" rounded="md" bg="bg.panel">
            <Text textStyle="xs" color="fg.muted">Осталось</Text>
            <Text textStyle="xl"><Countdown hours={hours} status={batch.status} /></Text>
            <Box mt="2"><LifeBar share={batch.lifeLeftShare} status={batch.status} /></Box>
          </Box>
          <Box p="4" borderWidth="1px" rounded="md" bg="bg.panel">
            <Text textStyle="xs" color="fg.muted">Статус</Text>
            <HStack mt="1" wrap="wrap">
              <StatusBadge status={batch.status} blocked={batch.blocked} />
              {batch.opened && <Badge colorPalette="purple">вскрыта</Badge>}
            </HStack>
            {batch.blockReason && <Text textStyle="xs" color="fg.muted" mt="1">{batch.blockReason}</Text>}
          </Box>
        </Grid>
      )}

      {batch && !batch.opened && batch.qtyLeft > 0 && can("COOK", "STOREKEEPER", "MANAGER") && (
        <HStack mb="4" gap="2" wrap="wrap">
          <Input w="24" size="sm" type="number" min={1} value={packs} onChange={(e) => setPacks(e.target.value)} />
          <Button size="sm" variant="outline" onClick={() => act(() => api.openBatch(loc, batchId, Number(packs)), "Вскрыто — отделена подпартия с коротким сроком")}>
            <LuPackageOpen /> Вскрыть упаковок
          </Button>
          <Text textStyle="xs" color="fg.muted" flex="1" minW="56">Если у продукта есть срок после вскрытия, вскрытая часть получает короткий срок</Text>
        </HStack>
      )}

      <Grid templateColumns={{ base: "1fr", xl: "1.3fr 1fr" }} gap="4">
        <Section title="Движения партии">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader hideBelow="md">№</Table.ColumnHeader>
                <Table.ColumnHeader>Когда</Table.ColumnHeader>
                <Table.ColumnHeader>Что</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end" whiteSpace="nowrap">Кол-во</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Сумма</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md">Кто</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {t.movements.map((m) => (
                <Table.Row key={m.id}>
                  <Table.Cell hideBelow="md" fontFamily="mono" color="fg.muted">{m.seq}</Table.Cell>
                  <Table.Cell textStyle="sm" whiteSpace={{ base: "normal", md: "nowrap" }}>{dateTime(m.at)}</Table.Cell>
                  <Table.Cell textStyle="sm">
                    {m.typeTitle}
                    {m.reason ? <Text color="fg.muted" textStyle="xs">{m.reason}</Text> : null}
                    <Text hideFrom="md" color="fg.muted" textStyle="xs">{m.actor}</Text>
                  </Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap" color={m.qty < 0 ? "red.fg" : "green.fg"} fontVariantNumeric="tabular-nums">
                    {m.qty > 0 ? "+" : ""}{m.qtyText}
                  </Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">{money(Math.abs(m.costKop))}</Table.Cell>
                  <Table.Cell hideBelow="md" textStyle="sm">{m.actor}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Section>

        <Stack gap="4">
          <Section title={`Куда ушла: заказы (${t.orders.length})`}>
            {t.orders.length === 0 ? <Text color="fg.muted" textStyle="sm">Из этой партии заказов не было</Text> : (
              <Stack gap="1" maxH="64" overflowY="auto">
                {t.orders.map((o) => (
                  <HStack key={o.orderId} justify="space-between" textStyle="sm" wrap="wrap" rowGap="0">
                    <Text>Заказ №{o.number} · {dateTime(o.at)}</Text>
                    <HStack><Text>{o.qtyText}</Text>
                      <Badge size="sm" colorPalette={ORDER_STATUS[o.status]?.palette}>{ORDER_STATUS[o.status]?.label}</Badge>
                    </HStack>
                  </HStack>
                ))}
              </Stack>
            )}
          </Section>
          {can("MANAGER", "ADMIN") && t.orders.length + t.ordersViaDerived.length > 0 && (
            <Section title="В какие блюда ушла">
              <BatchDishes batchId={batchId} />
            </Section>
          )}
          {t.derived.length > 0 && (
            <Section title="Из неё сделано">
              <Stack gap="1">
                {t.derived.map((d) => (
                  <HStack key={d.batchId} justify="space-between" cursor="pointer" textStyle="sm"
                          onClick={() => navigate(`/${loc}/batches/${d.batchId}`)}>
                    <Text>{d.source === "OPENING" ? "Вскрытая подпартия" : `Заготовка «${d.productName}»`} {d.label}</Text>
                    <Text>{d.qtyText}</Text>
                  </HStack>
                ))}
              </Stack>
              {t.ordersViaDerived.length > 0 && (
                <Text textStyle="xs" color="fg.muted" mt="2">Через них — ещё заказов: {t.ordersViaDerived.length}</Text>
              )}
            </Section>
          )}
        </Stack>
      </Grid>

      <WriteoffDialog batch={batch} open={writeoff} onClose={() => setWriteoff(false)} />
      <BlockDialog open={block} onClose={() => setBlock(false)}
                   onSubmit={(reason, cascade) => act(() => api.blockBatch(loc, batchId, reason, cascade), "Партия заблокирована — исключена из продажи")} />
      {batch && (
        <Dialog.Root open={label} onOpenChange={(e) => setLabel(e.open)} placement="center" size="sm">
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header><Dialog.Title>Этикетка партии</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <Box className="print-label" borderWidth="2px" borderColor="fg" rounded="md" p="4" bg="white" color="black">
                    <HStack align="start" gap="4">
                      <QrCode.Root value={`${window.location.origin}/${loc}/batches/${batchId}`} size="md">
                        <QrCode.Frame><QrCode.Pattern /></QrCode.Frame>
                      </QrCode.Root>
                      <Stack gap="1">
                        <Text fontWeight="bold" fontSize="lg" lineHeight="1.2">{t.productName}</Text>
                        <Text fontFamily="mono" fontSize="2xl" fontWeight="bold">{t.label}</Text>
                        <Text>Годна до: <b>{dateTimeYear(batch.expiresAt)}</b></Text>
                        <Text fontSize="sm">{batch.qtyText}{batch.opened ? " · вскрыта" : ""}</Text>
                      </Stack>
                    </HStack>
                  </Box>
                  <Text textStyle="xs" color="fg.muted" mt="3">
                    QR открывает карточку партии с телефона: вскрыть, заявка на списание.
                  </Text>
                </Dialog.Body>
                <Dialog.Footer>
                  <Button variant="outline" onClick={() => setLabel(false)}>Закрыть</Button>
                  <Button colorPalette="teal" onClick={() => {
                    document.body.classList.add("printing-label");
                    window.print();
                    document.body.classList.remove("printing-label");
                  }}><LuPrinter /> Печать</Button>
                </Dialog.Footer>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
    </>
  );
}

function sourceText(source: string, parent: number | null) {
  if (source === "PRODUCTION") return "Заготовка, приготовлена на кухне";
  if (source === "OPENING") return `Вскрытая подпартия партии #${parent}`;
  if (source === "SURPLUS") return "Излишек инвентаризации";
  return "";
}

function BlockDialog({ open, onClose, onSubmit }: { open: boolean; onClose: () => void;
  onSubmit: (reason: string, cascade: boolean) => void }) {
  const [reason, setReason] = useState("Отзыв поставщика");
  const [cascade, setCascade] = useState(true);
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Заблокировать партию</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Text textStyle="sm" color="fg.muted">Партия сразу исключается из доступного остатка, стоп-лист пересчитывается.</Text>
                <Field.Root>
                  <Field.Label>Причина</Field.Label>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
                </Field.Root>
                <Checkbox.Root checked={cascade} onCheckedChange={(e) => setCascade(!!e.checked)}>
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>Заблокировать и заготовки, сделанные из неё</Checkbox.Label>
                </Checkbox.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button colorPalette="red" disabled={!reason.trim()} onClick={() => { onSubmit(reason, cascade); onClose(); }}>
                Заблокировать
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
