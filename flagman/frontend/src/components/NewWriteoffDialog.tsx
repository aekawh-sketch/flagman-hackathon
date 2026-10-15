import { useEffect, useState } from "react";
import {
  Alert, Badge, Box, Button, CloseButton, Dialog, Field, Flex, HStack, Input, Portal, Stack, Text, Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, qty as fmtQty, WRITEOFF_REASONS } from "../format";
import { Loading, Segments } from "./ui";
import { PhotoPicker } from "./PhotoPicker";
import { SearchSelect } from "./SearchSelect";
import { Choice } from "./Choice";
import { notifyError, notifyOk } from "./Toaster";

const UNIT: Record<string, string> = { G: "г", ML: "мл", PCS: "шт" };

/**
 * Новая заявка на списание (ТЗ 6.5, 16.7) — целиком в разделе «Заявки на списание». Сначала выбирают
 * поставку (или заготовки кухни), потом продукты из неё и сколько, причину и фото. Несколько продуктов —
 * одна заявка. Кладовщик и повар только подают — управляющему или админу приходит запрос; управляющий
 * решает сам, и у него есть ещё списание блюда или напитка по техкарте.
 */
export function NewWriteoffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { loc, can } = useSession();
  const qc = useQueryClient();
  // Управляющий решает сам — его списание проходит сразу; блюдо или напиток по техкарте — только у него.
  const self = can("MANAGER", "ADMIN");
  const dishAllowed = can("MANAGER");
  const [kind, setKind] = useState<"delivery" | "dish">("delivery");
  const sources = useQuery({ queryKey: ["writeoff-sources", loc], queryFn: () => api.writeoffSources(loc), enabled: open });
  const menu = useQuery({ queryKey: ["menu", loc], queryFn: () => api.menu(loc), enabled: open && kind === "dish" });
  const dishes = (menu.data ?? []).filter((v) => v.tracked && !v.isSet);

  const list = sources.data ?? [];
  const [picked, setPicked] = useState("");
  const keyOf = (i: number) => list[i]?.deliveryId ?? list[i]?.kind ?? "";
  const source = list.find((_, i) => keyOf(i) === picked) ?? null;
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [variantId, setVariantId] = useState("");
  const [portions, setPortions] = useState("1");
  const [reason, setReason] = useState("SPOILED");
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setAmounts({}), [picked]);

  const chosen = (source?.lines ?? [])
    .map((l) => ({ l, n: Number(amounts[l.batchId] || 0) }))
    .filter((x) => x.n > 0);
  const linesOk = chosen.length > 0 && chosen.every((x) => Number.isInteger(x.n) && x.n <= x.l.available);
  const p = Number(portions || 0);
  const portionsOk = !!variantId && Number.isInteger(p) && p >= 1 && p <= 50;
  const ready = (kind === "delivery" ? linesOk : portionsOk) && photos.length > 0 && (reason !== "OTHER" || !!comment.trim());

  const close = () => {
    setPicked(""); setAmounts({}); setVariantId(""); setPortions("1");
    setReason("SPOILED"); setComment(""); setPhotos([]); setKind("delivery");
    onClose();
  };

  const submit = async () => {
    if (!photos.length) return;
    setBusy(true);
    try {
      const r = kind === "dish"
        ? await api.createWriteoffFefo(loc, { variantId, portions: p }, reason, comment.trim(), photos)
        : await api.createWriteoffBatches(loc, chosen.map((x) => ({ batchId: x.l.batchId, qty: x.n })), reason,
          comment.trim(), photos);
      if (r.needsApproval) notifyOk("Заявка отправлена на одобрение", "Управляющему и админу пришёл запрос; пока он не решён, товар не продаётся");
      else notifyOk("Списано", "В журнале видно, кто, что и почему списал");
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
      close();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} placement="center" scrollBehavior="inside"
                 size={{ base: "full", md: "lg" }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Новая заявка на списание</Dialog.Title></Dialog.Header>
            <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
            <Dialog.Body>
              <Stack gap="4">
                {dishAllowed && (
                  <Segments value={kind} onChange={(v) => setKind(v as "delivery" | "dish")}
                            items={[{ value: "delivery", label: "Продукты из поставки" }, { value: "dish", label: "Блюдо или напиток" }]} />
                )}

                {kind === "delivery" ? (
                  <>
                    <Field.Root required>
                      <Field.Label>Поставка</Field.Label>
                      {sources.isLoading ? <Loading rows={1} /> : !list.length ? (
                        <Text textStyle="sm" color="fg.muted">На складе нет ничего, что можно списать вручную</Text>
                      ) : (
                        <SearchSelect value={picked} onChange={setPicked} placeholder="Номер, поставщик или продукт"
                                      options={list.map((x, i) => ({
                                        value: keyOf(i),
                                        label: x.kind === "DELIVERY" ? `${x.number}${x.supplier ? ` · ${x.supplier}` : ""}` : x.number,
                                        // По подсказке ищется и продукт: «лосось» найдёт поставку, где он есть.
                                        hint: `${x.at ? `${dateTime(x.at)} · ` : ""}${x.lines.length} поз.: ${x.lines.map((l) => l.productName).join(", ")}`
                                          .slice(0, 80),
                                      }))} />
                      )}
                      <Field.HelperText>Сначала поставка, потом — какие продукты из неё и сколько</Field.HelperText>
                    </Field.Root>

                    {source && (
                      <Box>
                        <Text textStyle="sm" fontWeight="medium" mb="2">Что списать</Text>
                        <Stack gap="2">
                          {source.lines.map((l) => {
                            const v = amounts[l.batchId] ?? "";
                            const n = Number(v || 0);
                            const bad = n > l.available || (v !== "" && !Number.isInteger(n));
                            return (
                              <Flex key={l.batchId} gap="3" align="center" wrap="wrap" p="2.5" borderWidth="1px" rounded="md"
                                    borderColor={bad ? "red.muted" : n > 0 ? "red.emphasized" : undefined}>
                                <Box flex="1" minW="44">
                                  <HStack gap="1.5" wrap="wrap">
                                    <Text textStyle="sm" fontWeight="medium">{l.productName}</Text>
                                    <Badge size="sm" variant="outline" fontFamily="mono">{l.label}</Badge>
                                    {l.opened && <Badge size="sm" colorPalette="purple">вскрытая</Badge>}
                                  </HStack>
                                  <Text textStyle="xs" color="fg.muted">есть {l.availableText} · годна до {dateTime(l.expiresAt)}</Text>
                                </Box>
                                <HStack gap="1.5">
                                  <Input size="sm" w="24" type="number" min={0} max={l.available} inputMode="numeric" placeholder="0"
                                         value={v} aria-label={`Сколько списать: ${l.productName}, ${UNIT[l.unit]}`}
                                         onChange={(e) => setAmounts((a) => ({ ...a, [l.batchId]: e.target.value }))} />
                                  <Text textStyle="sm" color="fg.muted" w="6">{UNIT[l.unit]}</Text>
                                  <Button size="xs" variant="ghost"
                                          onClick={() => setAmounts((a) => ({ ...a, [l.batchId]: String(l.available) }))}>всё</Button>
                                </HStack>
                                {n > 0 && (
                                  <Text w="full" textStyle="xs" color={bad ? "red.fg" : "fg.muted"} mt="-1">
                                    {bad ? `Не больше ${l.availableText}, целым числом` : `= ${fmtQty(n, l.unit)}`}
                                  </Text>
                                )}
                              </Flex>
                            );
                          })}
                        </Stack>
                      </Box>
                    )}
                  </>
                ) : (
                  <>
                    <Field.Root required>
                      <Field.Label>Блюдо или напиток</Field.Label>
                      <SearchSelect value={variantId} onChange={setVariantId}
                                    placeholder={menu.isLoading ? "Загружаем меню…" : "Найти блюдо: «раф», «цезарь»…"}
                                    options={dishes.map((v) => ({ value: v.variantId, label: v.name, group: v.category ?? undefined }))} />
                      <Field.HelperText>Спишутся все продукты по техкарте, партии — по FEFO</Field.HelperText>
                    </Field.Root>
                    <Field.Root required invalid={!!variantId && !portionsOk}>
                      <Field.Label>Порций</Field.Label>
                      <Input type="number" min={1} max={50} inputMode="numeric" value={portions}
                             onChange={(e) => setPortions(e.target.value)} w="32" />
                      <Field.ErrorText>От 1 до 50</Field.ErrorText>
                    </Field.Root>
                  </>
                )}

                <Field.Root>
                  <Field.Label>Причина</Field.Label>
                  <Choice label="Причина" value={reason} onChange={setReason} options={WRITEOFF_REASONS} />
                  <Field.HelperText>Просрочку списывают отдельной кнопкой выше, когда срок партии истёк</Field.HelperText>
                </Field.Root>
                <Field.Root required={reason === "OTHER"}>
                  <Field.Label>Комментарий</Field.Label>
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
                            placeholder="Что случилось: «упала коробка», «запах», «протекла камера»" />
                </Field.Root>
                <Field.Root required>
                  <Field.Label>Фото</Field.Label>
                  <PhotoPicker files={photos} onChange={setPhotos} />
                </Field.Root>

                <Alert.Root status="info" size="sm">
                  <Alert.Indicator />
                  <Alert.Description>
                    {self
                      ? "Вы решаете сами — спишется сразу, без запроса. В журнале останется, кто, что и почему списал, с фото."
                      : "Сразу ничего не спишется: управляющему и админу придёт запрос — одобрить или отклонить. Пока он не решён, это количество не продаётся. Решение появится в списке заявок."}
                  </Alert.Description>
                </Alert.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              {!ready && (
                <Text textStyle="xs" color="fg.muted" me="auto">
                  {kind === "delivery" && !source ? "Выберите поставку"
                    : kind === "delivery" && !linesOk ? "Укажите, сколько списать"
                      : kind === "dish" && !portionsOk ? "Выберите блюдо"
                        : !photos.length ? "Нужно хотя бы одно фото" : "Для «прочее» нужен комментарий"}
                </Text>
              )}
              <Button variant="outline" onClick={close}>Отмена</Button>
              <Button colorPalette="red" loading={busy} disabled={!ready} onClick={submit}>
                {self ? "Списать" : "Отправить на одобрение"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
