import { useEffect, useState } from "react";
import {
  Alert, Badge, Box, Button, CloseButton, Dialog, Field, Flex, HStack, Input, Portal, Stack, Text, Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, money, qty as fmtQty } from "../format";
import type { ReturnReason } from "../types";
import { Loading } from "./ui";
import { Choice } from "./Choice";
import { PhotoPicker } from "./PhotoPicker";
import { notifyError, notifyOk } from "./Toaster";

export const RETURN_REASON: Record<ReturnReason, string> = {
  DEFECT: "Брак",
  WRONG_ITEM: "Не тот товар",
  SHORT_LIFE: "Короткий срок",
  DAMAGED_PACK: "Повреждена упаковка",
  QUALITY: "Не то качество",
  OTHER: "Прочее",
};

/** Из таких поставок уже есть что возвращать: товар принят на склад. */
export const RETURNABLE = ["ACCEPTED", "PARTIAL", "ACCEPTED_DIFF"];

const UNIT: Record<string, string> = { G: "г", ML: "мл", PCS: "шт" };

/**
 * Заявка на возврат поставщику (ТЗ 16.7): поставка из списка принятых, позиции и сколько вернуть,
 * причина и фото. Пока заявка ждёт, это количество не продаётся; подтверждает управляющий или админ.
 */
export function ReturnDialog({ open, onClose, deliveryId }: { open: boolean; onClose: () => void; deliveryId?: string }) {
  const { loc, can } = useSession();
  // Управляющий и админ сами решают — их возврат проходит сразу, без запроса.
  const self = can("MANAGER", "ADMIN");
  const qc = useQueryClient();
  const deliveries = useQuery({ queryKey: ["deliveries", loc], queryFn: () => api.deliveries(loc), enabled: open });
  const accepted = (deliveries.data ?? []).filter((d) => RETURNABLE.includes(d.status));
  const [picked, setPicked] = useState(deliveryId ?? "");
  const current = picked || accepted[0]?.id || "";
  const lines = useQuery({
    queryKey: ["returnable", loc, current], enabled: open && !!current,
    queryFn: () => api.returnable(loc, current),
  });
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [reason, setReason] = useState<ReturnReason>("DEFECT");
  const [comment, setComment] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);

  // Открыли из подробностей поставки — сразу она; сменили поставку — количества с чистого листа.
  useEffect(() => { if (open) setPicked(deliveryId ?? ""); }, [open, deliveryId]);
  useEffect(() => setAmounts({}), [current]);

  const rows = lines.data ?? [];
  const chosen = rows
    .map((l) => ({ l, n: Number(amounts[l.batchId] || 0) }))
    .filter((x) => x.n > 0);
  const tooMuch = chosen.some((x) => x.n > x.l.available || !Number.isInteger(x.n));
  const costKop = chosen.reduce((s, x) => s + Math.round(x.l.availableCostKop * Math.min(x.n, x.l.available) / x.l.available), 0);
  const ready = chosen.length > 0 && !tooMuch && photos.length > 0 && (reason !== "OTHER" || !!comment.trim());

  const close = () => {
    setAmounts({});
    setComment("");
    setPhotos([]);
    setReason("DEFECT");
    onClose();
  };

  const submit = async () => {
    if (!photos.length) return;
    setBusy(true);
    try {
      const r = await api.createReturn(loc, current, chosen.map((x) => ({ batchId: x.l.batchId, qty: x.n })), reason, comment.trim(), photos);
      if (r.status === "EXECUTED") notifyOk("Возврат оформлен", "Товар ушёл со склада как «возврат поставщику»");
      else notifyOk("Заявка на возврат отправлена", "Пока её не подтвердит управляющий или админ, этот товар не продаётся");
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
            <Dialog.Header><Dialog.Title>Возврат поставщику</Dialog.Title></Dialog.Header>
            <Dialog.CloseTrigger asChild><CloseButton size="sm" /></Dialog.CloseTrigger>
            <Dialog.Body>
              <Stack gap="4">
                <Field.Root required>
                  <Field.Label>Поставка</Field.Label>
                  {deliveries.isLoading ? <Loading rows={1} /> : !accepted.length ? (
                    <Text textStyle="sm" color="fg.muted">Принятых поставок нет — возвращать нечего</Text>
                  ) : (
                    <Choice label="Поставка" value={current} onChange={setPicked}
                            options={accepted.map((d) => ({ value: d.id, label: `${d.number}${d.supplier ? ` · ${d.supplier}` : ""}`,
                              hint: dateTime(d.createdAt) }))} />
                  )}
                </Field.Root>

                {current && (
                  <Box>
                    <Text textStyle="sm" fontWeight="medium" mb="2">Что вернуть</Text>
                    {lines.isLoading ? <Loading rows={2} /> : !rows.length ? (
                      <Text textStyle="sm" color="fg.muted">Из этой поставки на складе ничего не осталось или всё уже в заявках</Text>
                    ) : (
                      <Stack gap="2">
                        {rows.map((l) => {
                          const v = amounts[l.batchId] ?? "";
                          const n = Number(v || 0);
                          const bad = n > l.available || (v !== "" && !Number.isInteger(n));
                          return (
                            <Flex key={l.batchId} gap="3" align="center" wrap="wrap" p="2.5" borderWidth="1px" rounded="md"
                                  borderColor={n > 0 && !bad ? "teal.muted" : bad ? "red.muted" : undefined}>
                              <Box flex="1" minW="44">
                                <HStack gap="1.5" wrap="wrap">
                                  <Text textStyle="sm" fontWeight="medium">{l.productName}</Text>
                                  <Badge size="sm" variant="outline" fontFamily="mono">{l.batchLabel}</Badge>
                                  {l.opened && <Badge size="sm" colorPalette="purple">вскрытая</Badge>}
                                </HStack>
                                <Text textStyle="xs" color="fg.muted">
                                  можно вернуть {l.availableText} · годна до {dateTime(l.expiresAt)}
                                </Text>
                              </Box>
                              <HStack gap="1.5">
                                <Input size="sm" w="24" type="number" min={0} max={l.available} inputMode="numeric"
                                       placeholder="0" value={v} aria-label={`Сколько вернуть: ${l.productName}, ${UNIT[l.unit]}`}
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
                    )}
                  </Box>
                )}

                <Field.Root>
                  <Field.Label>Причина</Field.Label>
                  <Choice label="Причина" value={reason} onChange={(v) => setReason(v as ReturnReason)}
                          options={(Object.keys(RETURN_REASON) as ReturnReason[]).map((r) => ({ value: r, label: RETURN_REASON[r] }))} />
                </Field.Root>
                <Field.Root required={reason === "OTHER"}>
                  <Field.Label>Комментарий</Field.Label>
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
                            placeholder="Что не так: «пятна на филе», «вместо 33 % сливки 10 %»" />
                </Field.Root>
                <Field.Root required>
                  <Field.Label>Фото товара или накладной</Field.Label>
                  <PhotoPicker files={photos} onChange={setPhotos} />
                </Field.Root>

                <Alert.Root status="info" size="sm">
                  <Alert.Indicator />
                  <Alert.Description>
                    {self
                      ? "Вы решаете сами — товар сразу уйдёт со склада как «возврат поставщику». Это не потери ресторана."
                      : "Пока заявку не подтвердит управляющий или админ, этот товар не продаётся. После подтверждения он уходит со склада как «возврат поставщику» — это не потери ресторана."}
                  </Alert.Description>
                </Alert.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              {chosen.length > 0 && !tooMuch && (
                <Text textStyle="sm" color="fg.muted" me="auto">{chosen.length} поз. на ≈ {money(costKop)}</Text>
              )}
              <Button variant="outline" onClick={close}>Отмена</Button>
              <Button colorPalette="teal" loading={busy} disabled={!ready} onClick={submit}>{self ? "Оформить возврат" : "Отправить на подтверждение"}</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
