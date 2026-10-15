import { useState } from "react";
import { Badge, Box, Button, Card, Grid, HStack, SimpleGrid, Stack, Switch, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { LuFastForward, LuPause, LuPlay, LuRotateCcw } from "react-icons/lu";
import { api } from "../api";
import { useServerNow, useSession } from "../session";
import { dateTime } from "../format";
import { PageHeader, Section } from "../components/ui";
import { notifyError, notifyOk } from "../components/Toaster";
import { Choice } from "../components/Choice";

const SCENARIOS: { type: string; title: string; text: string; palette: string }[] = [
  { type: "SHORT_LIFE", title: "Поставка с коротким сроком", text: "Лосось, сливки, шампиньоны и креветки с перебором и сроком 20 ч — появятся горячие предложения.", palette: "orange" },
  { type: "SHORTAGE", title: "Дефицит лосося", text: "Банкет выбирает почти весь лосось — блюда с ним уходят в стоп, отказы с объяснением.", palette: "red" },
  { type: "RUSH", title: "Час пик", text: "Спрос ×3 на 2 часа: стоп-лист и прогноз стопа оживают.", palette: "purple" },
  { type: "SUSPICIOUS", title: "Подозрительный сотрудник", text: "Повар списывает свежий дорогой продукт как «порчу» — антифрод ловит (A2, A4), заявка ждёт подписи.", palette: "red" },
  { type: "LATE_CANCELS", title: "Поздние отмены", text: "Кассир отменяет готовящиеся заказы — потери на сотрудника, правило A5.", palette: "gray" },
];

/** Демо-панель (ТЗ 5.14): часы с ускорением, генератор событий, сценарии, сброс. */
/** Состояние демо-данных словами, а не служебным кодом сервера (idle, seeding: …, failed: …). */
function seedLabel(status?: string): string {
  if (!status || status === "idle" || status === "ready") return "готовы";
  if (status.startsWith("seeding")) return "готовятся" + (status.includes(":") ? ` — ${status.split(":")[1].trim()}` : "…");
  if (status.startsWith("failed")) return "ошибка: " + status.slice(status.indexOf(":") + 1).trim();
  return status;
}

export function DemoPage() {
  const { config, loc } = useSession();
  const qc = useQueryClient();
  const now = useServerNow();
  const state = useQuery({ queryKey: ["demo-state"], queryFn: api.demoState, refetchInterval: 5000 });
  const [scenarioLoc, setScenarioLoc] = useState(loc);
  const s = state.data;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      const r = await fn();
      const msg = (r as { message?: string })?.message ?? ok;
      if (msg) notifyOk(msg);
      qc.invalidateQueries();
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader title="Демо-панель" subtitle="Ускорьте время, чтобы за пару минут увидеть, как стареют партии, появляются горячие предложения и блюда уходят в стоп" />
      <Grid templateColumns={{ base: "1fr", xl: "1fr 1.4fr" }} gap="4" alignItems="start">
        <Stack gap="4">
          <Section title="Часы системы">
            <Text textStyle="3xl" fontWeight="bold" fontVariantNumeric="tabular-nums">{dateTime(now)}</Text>
            <HStack mt="1" mb="4">
              <Badge colorPalette={s?.clock.mode === "SIM" ? "purple" : "gray"}>{s?.clock.mode === "SIM" ? "демо-время" : "реальное время"}</Badge>
              {s?.clock.mode === "SIM" && <Badge>{s.clock.paused ? "пауза" : `×${s.clock.speed}`}</Badge>}
            </HStack>
            <Text textStyle="sm" fontWeight="semibold" mb="2">Скорость</Text>
            <HStack mb="4" wrap="wrap">
              {[1, 60, 600, 1800].map((sp) => (
                <Button key={sp} size="sm" variant={s?.clock.speed === sp && !s.clock.paused ? "solid" : "outline"} colorPalette="purple"
                        onClick={() => run(() => api.demoClock({ speed: sp, paused: false }))}>
                  <LuPlay /> ×{sp}
                </Button>
              ))}
              <Button size="sm" variant="outline" onClick={() => run(() => api.demoClock({ speed: s?.clock.speed ?? 1, paused: true }))}>
                <LuPause /> Пауза
              </Button>
            </HStack>
            <Text textStyle="sm" fontWeight="semibold" mb="2">Перемотать вперёд</Text>
            <HStack wrap="wrap">
              {[1, 3, 6, 24].map((h) => (
                <Button key={h} size="sm" variant="outline" onClick={() => run(() => api.demoClock({ advanceHours: h }))}>
                  <LuFastForward /> +{h} ч
                </Button>
              ))}
            </HStack>
            <Text textStyle="xs" color="fg.muted" mt="3">Назад время не идёт: журнал упорядочен по времени.</Text>
          </Section>
          <Section title="Генератор событий">
            <Switch.Root checked={!!s?.generator} onCheckedChange={(e) => run(() => api.demoGenerator(e.checked))} colorPalette="teal"
                         alignItems="flex-start">
              <Switch.HiddenInput />
              <Switch.Control><Switch.Thumb /></Switch.Control>
              <Switch.Label>Гости заказывают, утром приходят поставки, повар готовит заготовки</Switch.Label>
            </Switch.Root>
            <Text textStyle="xs" color="fg.muted" mt="2">Генератор работает через тот же API, что и внешние системы, со своим ключом.</Text>
          </Section>
          <Section title="Для жюри и интеграции">
            <Stack gap="2" textStyle="sm">
              <Link to={`/${loc}/docs`}><Text color="teal.fg" textDecoration="underline">Документация всей программы</Text></Link>
              <Text color="fg.muted" textStyle="xs" mt="-1">Что выполнено по кейсу, что добавили сверх него и как это работает</Text>
              <a href="/swagger-ui/index.html" target="_blank" rel="noreferrer"><Text color="teal.fg" textDecoration="underline">Документация API (Swagger)</Text></a>
              <Text color="fg.muted">Демо-данные: {seedLabel(s?.seed)}</Text>
            </Stack>
            <Button mt="4" size="sm" variant="outline" colorPalette="red"
                    onClick={() => window.confirm("Пересоздать все демо-данные? Это займёт около минуты.") && run(api.demoReset)}>
              <LuRotateCcw /> Сбросить демо-данные
            </Button>
          </Section>
        </Stack>

        <Section title="Сценарии" actions={
          <Choice size="sm" w="auto" minW="40" label="Точка" value={scenarioLoc} onChange={setScenarioLoc}
                  options={(config?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />}>
          <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
            {SCENARIOS.map((sc) => (
              <Card.Root key={sc.type} variant="outline">
                <Card.Body gap="2">
                  <Text fontWeight="semibold">{sc.title}</Text>
                  <Text textStyle="sm" color="fg.muted" flex="1">{sc.text}</Text>
                  <Box>
                    <Button size="sm" colorPalette={sc.palette} onClick={() => run(() => api.demoScenario(scenarioLoc, sc.type))}>Запустить</Button>
                  </Box>
                </Card.Body>
              </Card.Root>
            ))}
          </SimpleGrid>
        </Section>
      </Grid>
    </>
  );
}
