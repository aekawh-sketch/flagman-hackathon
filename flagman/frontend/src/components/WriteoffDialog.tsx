import { useState } from "react";
import { Alert, Button, Dialog, Field, Input, Portal, Stack, Text, Textarea } from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../session";
import type { BatchDto } from "../types";
import { PhotoPicker } from "./PhotoPicker";
import { Choice } from "./Choice";
import { WRITEOFF_REASONS } from "../format";
import { notifyError, notifyOk } from "./Toaster";

/**
 * Ручное списание = заявка (ТЗ 6.5): причина, фото обязательно. «Просрочки» в списке нет —
 * её списывают отдельной кнопкой и только после срока (ТЗ 16.1).
 */
export function WriteoffDialog({ batch, open, onClose }: { batch: BatchDto | null; open: boolean; onClose: () => void }) {
  const { loc, can } = useSession();
  const qc = useQueryClient();
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("SPOILED");
  const [comment, setComment] = useState("");
  // Несколько фото: превью с приближением до отправки, лишнее убирается крестиком.
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  if (!batch) return null;
  const max = batch.qtyLeft - batch.held;

  const submit = async () => {
    if (!photos.length) return notifyError(new Error("Нужно фото"));
    setBusy(true);
    try {
      const r = await api.createWriteoff(loc, batch.id, Number(qty), reason, comment, photos);
      notifyOk(r.needsApproval ? "Заявка отправлена на подпись" : "Списано",
        r.needsApproval ? "Пока заявка ждёт, это количество не продаётся" : undefined);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
      onClose();
      setQty("");
      setComment("");
      setPhotos([]);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Заявка на списание</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Text>{batch.productName} · партия {batch.label} · остаток {batch.qtyText}</Text>
                {max <= 0 && (
                  <Alert.Root status="warning" size="sm"><Alert.Indicator />
                    <Alert.Title>Всё количество этой партии уже под другой заявкой на списание — списывать нечего, пока её не решат</Alert.Title>
                  </Alert.Root>
                )}
                <Alert.Root status="info" size="sm"><Alert.Indicator />
                  <Alert.Title>{can("MANAGER", "ADMIN")
                    ? "Вы решаете сами — спишется сразу, в журнале будет видно, кто и почему"
                    : "Заявку одобряет или отклоняет управляющий или админ — пока ждёт, товар не продаётся"}</Alert.Title>
                </Alert.Root>
                <Field.Root required>
                  <Field.Label>Количество ({batch.unit === "PCS" ? "шт" : batch.unit === "ML" ? "мл" : "г"})</Field.Label>
                  <Input type="number" min={1} max={max} value={qty} onChange={(e) => setQty(e.target.value)} />
                  <Field.HelperText>{max > 0 ? `Не больше ${max}` : "Свободного количества нет"}</Field.HelperText>
                </Field.Root>
                <Field.Root>
                  <Field.Label>Причина</Field.Label>
                  <Choice label="Причина" value={reason} onChange={setReason} options={WRITEOFF_REASONS} />
                  <Field.HelperText>Просрочку списывают отдельной кнопкой «Списать», когда срок партии истёк</Field.HelperText>
                </Field.Root>
                <Field.Root required={reason === "OTHER"}>
                  <Field.Label>Комментарий</Field.Label>
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
                </Field.Root>
                <Field.Root required>
                  <Field.Label>Фото</Field.Label>
                  <PhotoPicker files={photos} onChange={setPhotos} />
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button colorPalette="red" loading={busy} disabled={!qty || Number(qty) <= 0 || Number(qty) > max || !photos.length}
                      onClick={submit}>Отправить</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
