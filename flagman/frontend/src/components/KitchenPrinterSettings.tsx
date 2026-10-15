import { useEffect, useState } from "react";
import { Box, Button, Field, Grid, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuPrinter } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import type { KitchenPrinter } from "../types";
import { Choice } from "./Choice";
import { Loading, Section, Segments } from "./ui";
import { notifyError, notifyOk } from "./Toaster";

const MODES = [
  { value: "SCREEN", label: "Экран кухни" },
  { value: "NETWORK", label: "Сетевой принтер" },
  { value: "OFF", label: "Выключено" },
];
const MODE_TEXT: Record<KitchenPrinter["mode"], string> = {
  SCREEN: "Принтера нет: чек появляется на экране кухни у повара. Если к компьютеру кухни подключён USB-принтер — "
    + "повар печатает чек кнопкой «Печать здесь».",
  NETWORK: "Термопринтер в сети ресторана (Epson TM, Xprinter, Атол — с портом Ethernet или Wi-Fi). Чек уходит сам, "
    + "командами ESC/POS на порт 9100. IP принтера печатается на его тест-странице: включите принтер с зажатой кнопкой FEED.",
  OFF: "Чеки на кухню не создаются.",
};

/** Принтер одной точки: режим, адрес, лента, копии; «Пробная печать». */
function PrinterCard({ loc, name }: { loc: string; name: string }) {
  const qc = useQueryClient();
  const saved = useQuery({ queryKey: ["kitchen-printer", loc], queryFn: () => api.kitchenPrinter(loc) });
  const [form, setForm] = useState<Omit<KitchenPrinter, "locationId"> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (saved.data && !form) {
      const { locationId: _, ...rest } = saved.data;
      setForm(rest);
    }
  }, [saved.data, form]);
  if (!form) return <Loading rows={2} />;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const save = async () => {
    setBusy(true);
    try {
      await api.saveKitchenPrinter(loc, form);
      qc.invalidateQueries({ queryKey: ["kitchen-printer", loc] });
      notifyOk(`Принтер кухни «${name}» сохранён`);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      await api.saveKitchenPrinter(loc, form);
      const r = await api.testKitchenPrinter(loc);
      if (r.status === "FAILED") notifyError(new Error(r.error ?? "Принтер не ответил"));
      else notifyOk(r.status === "SHOWN" ? "Режим «экран кухни» — печатать нечего" : "Пробный чек напечатан", r.printer);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={<HStack as="span" gap="2"><LuPrinter /><span>{name}</span></HStack>}>
      <Stack gap="3">
        <Segments value={form.mode} onChange={(v) => set({ mode: v as KitchenPrinter["mode"] })} items={MODES} />
        <Text textStyle="sm" color="fg.muted">{MODE_TEXT[form.mode]}</Text>
        {form.mode === "NETWORK" && (
          <Grid templateColumns={{ base: "1fr", sm: "2fr 1fr" }} gap="3">
            <Field.Root required>
              <Field.Label>Адрес принтера</Field.Label>
              <Input value={form.host ?? ""} onChange={(e) => set({ host: e.target.value })} placeholder="192.168.1.50" inputMode="decimal" />
              <Field.HelperText>Только сеть ресторана: 192.168.x.x, 10.x.x.x, 172.16–31.x.x</Field.HelperText>
            </Field.Root>
            <Field.Root>
              <Field.Label>Порт</Field.Label>
              <Input value={String(form.port)} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 9100 })} inputMode="numeric" />
            </Field.Root>
          </Grid>
        )}
        {form.mode !== "OFF" && (
          <Grid templateColumns={{ base: "1fr 1fr", sm: "repeat(2, minmax(0, 12rem))" }} gap="3">
            <Field.Root>
              <Field.Label>Лента</Field.Label>
              <Choice value={String(form.paperMm)} onChange={(v) => set({ paperMm: Number(v) as 58 | 80 })} label="Лента"
                      options={[{ value: "80", label: "80 мм", hint: "48 знаков" }, { value: "58", label: "58 мм", hint: "32 знака" }]} />
            </Field.Root>
            <Field.Root>
              <Field.Label>Копий</Field.Label>
              <Choice value={String(form.copies)} onChange={(v) => set({ copies: Number(v) })} label="Копий"
                      options={[1, 2, 3].map((n) => ({ value: String(n), label: String(n), hint: n === 2 ? "горячий цех + холодный" : undefined }))} />
            </Field.Root>
          </Grid>
        )}
        <HStack gap="2">
          <Button colorPalette="teal" loading={busy} onClick={save}>Сохранить</Button>
          {form.mode !== "OFF" && <Button variant="outline" loading={busy} onClick={test}>Пробная печать</Button>}
        </HStack>
      </Stack>
    </Section>
  );
}

/**
 * Принтер кухни (ТЗ 16.15): кассир пробил заказ — на кухне печатается чек с блюдами. У каждой точки свой принтер.
 */
export function KitchenPrinterSettings() {
  const { config } = useSession();
  return (
    <Stack gap="4">
      <Text textStyle="sm" color="fg.muted">
        Кассир пробил заказ — на кухне печатается чек: номер, блюда и состав сетов. Сервер отправляет его на принтер
        после того, как заказ сохранён, в фоне — касса не ждёт принтер. Не напечаталось — повар и управляющий получают
        сигнал, на экране кухни есть «Ещё раз».
      </Text>
      <Box>
        <Grid templateColumns={{ base: "1fr", xl: "1fr 1fr" }} gap="4" alignItems="start">
          {config?.locations.map((l) => <PrinterCard key={l.id} loc={l.id} name={l.name} />)}
        </Grid>
      </Box>
    </Stack>
  );
}
