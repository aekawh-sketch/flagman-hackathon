import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Alert, Badge, Box, Button, Checkbox, CloseButton, Code, Dialog, Field, Flex, Grid, HStack, Input, Portal,
  SimpleGrid, Stack, Table, Tabs, Text,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuDownload, LuFileUp, LuTrash2 } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, ROLE, roleOptions, plural } from "../format";
import { PageHeader, Section } from "../components/ui";
import type { CatalogImportResult, UserDto } from "../types";
import { notifyError, notifyOk } from "../components/Toaster";
import { InvitePanel } from "../components/InvitePanel";
import { Choice } from "../components/Choice";
import { KitchenPrinterSettings } from "../components/KitchenPrinterSettings";
import { blankLocation, LocationRows, rowsState, type LocationRow } from "../components/LocationRows";

const SETTING_LABELS: Record<string, string> = {
  restaurant_name: "Название ресторана",
  writeoff_threshold_kop: "Порог «дорогого» списания и крупного расхождения пересчёта, коп.",
  anomaly_a1_factor: "A1: во сколько раз больше медианы",
  anomaly_a2_fresh_share: "A2: доля оставшегося срока (0–1)",
  anomaly_a3_closing_share: "A3: доля списаний в последний час",
  anomaly_a5_late_cancels: "A5: поздних отмен за 7 дней",
  anomaly_a6_recipe_growth: "A6: рост граммовки (0–1)",
  generator_enabled: "Генератор событий включён",
  auto_writeoff_expired: "Автосписание просрочки системой (true/false); по умолчанию списывает человек",
  pos_url: "Адрес кассы — панель персонала ресторана (https://…); кассир входит туда своим логином и паролем",
};

const SCOPES = ["orders:create", "orders:status", "orders:cancel", "deliveries:create", "deliveries:accept",
  "deliveries:auto-accept", "stock:read", "menu:read", "analytics:read", "events:read", "catalog:import"];

export function AdminPage() {
  const { me, loc } = useSession();
  const navigate = useNavigate();
  // Вкладка — в адресе: «Админка → Меню» можно открыть ссылкой, «Назад» возвращает на ту же вкладку.
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "users";
  const go = (t: string) => setParams((p) => { p.set("tab", t); return p; }, { replace: true });
  const welcome = params.has("welcome");
  return (
    <>
      <PageHeader title="Админка" subtitle={<>Предприятие «{me?.tenantName}»: точки, сотрудники и приглашения, API-ключи, пороги антифрода, аудит</>} />
      {/* Только что созданное или одобренное предприятие пустое — подсказываем, с чего начать. */}
      {welcome && (
        <Alert.Root status="success" mb="5" alignItems="start">
          <Alert.Indicator />
          <Alert.Content gap="2">
            <Alert.Title>Добро пожаловать в «{me?.tenantName}» — вы его админ</Alert.Title>
            <Alert.Description>Предприятие пока пустое. Первые шаги:</Alert.Description>
            <Flex gap="2" wrap="wrap">
              <Button size="sm" variant="outline" onClick={() => go("menu")}>1. Загрузить меню</Button>
              <Button size="sm" variant="outline" onClick={() => go("invites")}>2. Пригласить сотрудников</Button>
              <Button size="sm" variant="outline" onClick={() => navigate(`/${loc}/acceptance`)}>3. Принять первую поставку</Button>
            </Flex>
          </Alert.Content>
          <CloseButton size="sm" onClick={() => setParams((p) => { p.delete("welcome"); return p; }, { replace: true })} />
        </Alert.Root>
      )}
      <Tabs.Root value={tab} onValueChange={(e) => go(e.value)} variant="line">
        <Tabs.List mb="4" overflowX="auto" css={{ scrollbarWidth: "none" }}>
          <Tabs.Trigger value="users" flexShrink={0} whiteSpace="nowrap">Сотрудники</Tabs.Trigger>
          <Tabs.Trigger value="invites" flexShrink={0} whiteSpace="nowrap">Приглашения</Tabs.Trigger>
          <Tabs.Trigger value="locations" flexShrink={0} whiteSpace="nowrap">Точки</Tabs.Trigger>
          <Tabs.Trigger value="menu" flexShrink={0} whiteSpace="nowrap">Меню</Tabs.Trigger>
          <Tabs.Trigger value="keys" flexShrink={0} whiteSpace="nowrap">API-ключи</Tabs.Trigger>
          <Tabs.Trigger value="printer" flexShrink={0} whiteSpace="nowrap">Принтер кухни</Tabs.Trigger>
          <Tabs.Trigger value="settings" flexShrink={0} whiteSpace="nowrap">Настройки</Tabs.Trigger>
          <Tabs.Trigger value="audit" flexShrink={0} whiteSpace="nowrap">Аудит</Tabs.Trigger>
          <Tabs.Trigger value="clean" flexShrink={0} whiteSpace="nowrap">Очистка</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="users"><Users /></Tabs.Content>
        <Tabs.Content value="invites"><Invites /></Tabs.Content>
        <Tabs.Content value="locations"><Locations /></Tabs.Content>
        <Tabs.Content value="menu"><MenuImport /></Tabs.Content>
        <Tabs.Content value="keys"><Keys /></Tabs.Content>
        <Tabs.Content value="printer"><KitchenPrinterSettings /></Tabs.Content>
        <Tabs.Content value="settings"><Settings /></Tabs.Content>
        <Tabs.Content value="audit"><Audit /></Tabs.Content>
        <Tabs.Content value="clean"><CleanSlate /></Tabs.Content>
      </Tabs.Root>
    </>
  );
}

function Users() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });
  const { config, me } = useSession();
  const [form, setForm] = useState({ login: "", name: "", role: "COOK", password: "", pin: "", locationId: "" });
  const locName = (id: string | null) => config?.locations.find((l) => l.id === id)?.name;
  const change = async (id: number, body: { role?: string; locationId?: string; active?: boolean }) => {
    try {
      await api.updateUser(id, body);
      notifyOk(body.role ? `Роль: ${ROLE[body.role as keyof typeof ROLE]}` : body.locationId !== undefined
        ? `Точка: ${body.locationId ? locName(body.locationId) : "все точки"}` : body.active ? "Сотрудник включён" : "Сотрудник отключён");
    } catch (e) {
      notifyError(e);
    } finally {
      qc.invalidateQueries({ queryKey: ["users"] });
    }
  };
  const create = async () => {
    try {
      await api.createUser({ ...form, password: form.password || null, pin: form.pin || null, locationId: form.locationId || null });
      notifyOk("Сотрудник создан");
      setForm({ login: "", name: "", role: "COOK", password: "", pin: "", locationId: "" });
      qc.invalidateQueries({ queryKey: ["users"] });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Grid templateColumns={{ base: "1fr", xl: "1.4fr 1fr" }} gap="4" alignItems="start">
      <Section title="Сотрудники">
        <Table.Root size="sm">
          <Table.Body>
            {users.data?.map((u) => (
              <Table.Row key={u.id}>
                <Table.Cell>
                  <Text fontWeight="medium">{u.name}</Text>
                  <Text textStyle="xs" color="fg.muted">
                    {u.login}<Box as="span" hideFrom="md">{u.hasPin && " · PIN"}</Box>
                  </Text>
                  {/* На телефоне роль и точка — под именем: колонка справа скрыта. */}
                  <Box hideFrom="md" mt="1.5"><RoleControls u={u} self={u.id === me?.id} onChange={change} /></Box>
                </Table.Cell>
                <Table.Cell hideBelow="md"><RoleControls u={u} self={u.id === me?.id} onChange={change} /></Table.Cell>
                <Table.Cell hideBelow="md">{u.hasPin && <Badge size="sm">PIN</Badge>}</Table.Cell>
                <Table.Cell textAlign="end">
                  <Button size="xs" variant="outline" disabled={u.id === me?.id}
                          onClick={() => change(u.id, { active: !u.active })}>{u.active ? "Отключить" : "Включить"}</Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Section>
      <Section title="Новый сотрудник">
        <Stack gap="3">
          <Field.Root><Field.Label>Логин</Field.Label><Input value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} /></Field.Root>
          <Field.Root><Field.Label>Имя</Field.Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field.Root>
          <Choice label="Роль" value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={roleOptions()} />
          <Field.Root><Field.Label>Пароль (офис)</Field.Label><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field.Root>
          <Choice label="Точка" value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })}
                  options={[{ value: "", label: "Все точки" }, ...(config?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))]} />
          <Field.Root><Field.Label>PIN для списаний (4–6 цифр)</Field.Label><Input value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} /></Field.Root>
          <Button colorPalette="teal" onClick={create} disabled={!form.login || !form.name}>Создать</Button>
          <Text textStyle="xs" color="fg.muted">Человек уже работает в другом ресторане на этой платформе? Не заводите вторую учётку —
            пригласите его ссылкой во вкладке «Приглашения».</Text>
        </Stack>
      </Section>
    </Grid>
  );
}

/** Роль и точка сотрудника меняются только в админке; себя админ не понижает (ТЗ 16.4). */
function RoleControls({ u, self, onChange }: { u: UserDto; self: boolean;
  onChange: (id: number, body: { role?: string; locationId?: string }) => void }) {
  const { config } = useSession();
  return (
    <Stack gap="1" minW="40" maxW="56">
      <Choice size="xs" disabled={self} label="Роль" value={u.role} onChange={(v) => onChange(u.id, { role: v })} options={roleOptions()} />
      <Choice size="xs" label="Точка" value={u.locationId ?? ""} onChange={(v) => onChange(u.id, { locationId: v })}
              options={[{ value: "", label: "все точки" }, ...(config?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))]} />
    </Stack>
  );
}

/**
 * Меню предприятия (ТЗ п. 48, 16.4): новое предприятие начинает с пустого каталога — загрузите меню из Excel
 * или пришлите JSON в API. Повторная загрузка обновляет меню, изменившаяся техкарта получает новую версию.
 */
function MenuImport() {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CatalogImportResult | null>(null);
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const r = await api.importCatalogFile(file);
      setResult(r);
      notifyOk("Меню загружено", `Продуктов: ${r.products}, блюд: ${r.dishes}, вариантов: ${r.variants}`);
      qc.invalidateQueries();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  const dishes = catalog.data?.dishes.length ?? 0;
  const products = catalog.data?.products.length ?? 0;
  return (
    <Grid templateColumns={{ base: "1fr", xl: "1.2fr 1fr" }} gap="4" alignItems="start">
      <Section title="Загрузить меню">
        <Stack gap="3">
          <Text textStyle="sm" color="fg.muted">
            Сейчас в меню: блюд {dishes}, продуктов {products}. Excel — листы «Продукты», «Заготовки», «Блюда» (и при желании
            «Сеты»): по строке на ингредиент, цена в рублях, нетто в г, мл или шт. Скачайте пример — небольшое меню кофейни, —
            замените своим и загрузите. Повторная загрузка обновит меню, старые заказы сохранят свои техкарты.
          </Text>
          <HStack gap="2" wrap="wrap">
            <Button colorPalette="teal" loading={busy} onClick={() => ref.current?.click()}><LuFileUp /> Загрузить Excel или JSON</Button>
            <Button asChild variant="outline"><a href={api.catalogSampleXlsxUrl} download="menu-sample.xlsx"><LuDownload /> Пример Excel</a></Button>
            <Button asChild variant="ghost"><a href={api.catalogSampleJsonUrl} download="menu-sample.json"><LuDownload /> Пример JSON</a></Button>
          </HStack>
          <input ref={ref} hidden type="file"
                 accept=".xlsx,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                 onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          {result && (
            <Text textStyle="sm" color="green.fg">
              Загружено: продуктов {result.products}, блюд {result.dishes}, вариантов {result.variants},
              новых версий техкарт {result.newRecipeVersions}.
            </Text>
          )}
        </Stack>
      </Section>
      <Section title="Через API">
        <Stack gap="2" textStyle="sm">
          <Text>Меню можно прислать из учётной системы:</Text>
          <Code display="block" whiteSpace="pre-wrap" p="2">POST /api/catalog/import{"\n"}Content-Type: application/json</Code>
          <Text color="fg.muted">
            Тело — как в «Пример JSON»: продукты, заготовки (semi), блюда с вариантами и техкартами, сеты. Нужен вход
            админа или API-ключ с правом <Code size="sm">catalog:import</Code> (вкладка «API-ключи»). Excel тоже можно
            прислать в API: <Code size="sm">POST /api/catalog/import/xlsx</Code> с файлом в поле file.
          </Text>
          <Button asChild size="sm" variant="outline" alignSelf="flex-start">
            <a href="/swagger-ui/index.html" target="_blank" rel="noreferrer">Открыть Swagger</a>
          </Button>
        </Stack>
      </Section>
    </Grid>
  );
}

function Keys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: api.apiKeys });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["orders:create", "menu:read"]);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Grid templateColumns={{ base: "1fr", xl: "1.4fr 1fr" }} gap="4" alignItems="start">
      <Section title="Ключи">
        <Table.Root size="sm">
          <Table.Body>
            {keys.data?.map((k) => (
              <Table.Row key={k.id}>
                <Table.Cell>
                  <Text fontWeight="medium">{k.name}</Text><Code size="sm">{k.prefix}…</Code>
                  <HStack hideFrom="md" gap="1" wrap="wrap" mt="1">{k.scopes.map((s) => <Badge key={s} size="sm">{s}</Badge>)}</HStack>
                </Table.Cell>
                <Table.Cell hideBelow="md"><HStack gap="1" wrap="wrap">{k.scopes.map((s) => <Badge key={s} size="sm">{s}</Badge>)}</HStack></Table.Cell>
                <Table.Cell textAlign="end">
                  {k.revoked ? <Badge colorPalette="red">отозван</Badge> : (
                    <Button size="xs" variant="outline" colorPalette="red" onClick={async () => {
                      await api.revokeApiKey(k.id);
                      qc.invalidateQueries({ queryKey: ["api-keys"] });
                    }}>Отозвать</Button>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Section>
      <Section title="Новый ключ">
        <Stack gap="3">
          <Field.Root><Field.Label>Название</Field.Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Сайт ресторана" /></Field.Root>
          <HStack gap="1.5" wrap="wrap">
            {SCOPES.map((s) => (
              <Badge key={s} cursor="pointer" variant={scopes.includes(s) ? "solid" : "outline"} colorPalette="teal"
                     onClick={() => setScopes(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s])}>{s}</Badge>
            ))}
          </HStack>
          <Button colorPalette="teal" disabled={!name} onClick={async () => {
            try {
              const r = await api.createApiKey(name, scopes);
              setCreated(r.key);
              qc.invalidateQueries({ queryKey: ["api-keys"] });
            } catch (e) {
              notifyError(e);
            }
          }}>Создать</Button>
          {created && (
            <Stack p="3" rounded="md" bg="yellow.subtle" gap="1">
              <Text textStyle="sm" fontWeight="semibold">Ключ показывается один раз — в базе только его хэш:</Text>
              <Code wordBreak="break-all">{created}</Code>
              <Text textStyle="xs">Передавайте в заголовке X-Api-Key</Text>
            </Stack>
          )}
        </Stack>
      </Section>
    </Grid>
  );
}

function Settings() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [edit, setEdit] = useState<Record<string, string>>({});
  return (
    <Section title="Пороги и настройки (ТЗ 4.4)">
      <Stack gap="2" maxW="2xl">
        {Object.entries(settings.data ?? {}).filter(([k]) => SETTING_LABELS[k]).map(([k, v]) => (
          <Flex key={k} justify="space-between" align="center" gap="2" wrap={{ base: "wrap", sm: "nowrap" }}>
            <Text textStyle="sm" flex="1" flexBasis={{ base: "full", sm: "auto" }}>{SETTING_LABELS[k]}</Text>
            <Input size="sm" w={{ base: "auto", sm: "56" }} flex={{ base: "1", sm: "initial" }} value={edit[k] ?? v}
                   onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
            <Button size="sm" variant="outline" disabled={edit[k] === undefined || edit[k] === v} onClick={async () => {
              try {
                await api.setSetting(k, edit[k]);
                notifyOk("Сохранено");
                qc.invalidateQueries({ queryKey: ["settings"] });
              } catch (e) {
                notifyError(e);
              }
            }}>Сохранить</Button>
          </Flex>
        ))}
      </Stack>
    </Section>
  );
}

function Audit() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.audit });
  return (
    <Section title="Аудит действий админа (только добавление, своя хэш-цепочка)">
      <Table.Root size="sm">
        <Table.Body>
          {audit.data?.map((a) => (
            <Table.Row key={a.seq}>
              <Table.Cell hideBelow="md" fontFamily="mono">{a.seq}</Table.Cell>
              <Table.Cell whiteSpace="nowrap" verticalAlign="top">{dateTime(a.at)}</Table.Cell>
              <Table.Cell>
                <Text>{a.actorName ?? "система"}</Text>
                <Box hideFrom="md" mt="1"><Badge size="sm">{a.action}</Badge></Box>
                <Code hideFrom="md" size="sm" mt="1" lineClamp={2} wordBreak="break-all">{a.details}</Code>
              </Table.Cell>
              <Table.Cell hideBelow="md"><Badge size="sm">{a.action}</Badge></Table.Cell>
              <Table.Cell hideBelow="md"><Code size="sm" lineClamp={1}>{a.details}</Code></Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Section>
  );
}

/**
 * Приглашение по ссылке (ТЗ 16.4): роль и точка приходят вместе со ссылкой, ссылка одноразовая, 7 дней.
 * Приглашать можно в любое предприятие, где вы админ (ТЗ 16.9), — точки берутся из выбранного.
 */
function Invites() {
  const { me } = useSession();
  // Свои предприятия, где вы админ; чужие (созданные другими людьми) не видны — изоляция данных.
  const mine = me?.tenants.filter((t) => t.role === "ADMIN") ?? [];
  const [tenant, setTenant] = useState(me?.tenantId ?? 0);
  const tenantName = mine.find((t) => t.tenantId === tenant)?.tenantName ?? me?.tenantName;
  const locations = useQuery({ queryKey: ["admin-locations", tenant], queryFn: () => api.locations(tenant) });
  return (
    <Stack gap="4">
      {mine.length > 1 && (
        <Flex align={{ base: "stretch", sm: "center" }} gap="3" direction={{ base: "column", sm: "row" }}>
          <Text fontWeight="medium" flexShrink={0}>Предприятие</Text>
          <Choice maxW={{ sm: "sm" }} label="Предприятие" value={String(tenant)} onChange={(v) => setTenant(Number(v))}
                  options={mine.map((t) => ({ value: String(t.tenantId), label: t.tenantName,
                    hint: t.tenantId === me?.tenantId ? "текущее" : undefined }))} />
          <Text textStyle="xs" color="fg.muted">Все, где вы админ. Чужие предприятия здесь не видны.</Text>
        </Flex>
      )}
      {/* Ключ — предприятие: при смене формы и показанная ссылка начинаются заново */}
      <InvitePanel key={tenant} queryKey={["invites", tenant]} locations={locations.data}
                   title={mine.length > 1 ? `Приглашения в «${tenantName}»` : "Приглашения"}
                   list={() => api.invites(tenant)}
                   create={(role, loc, note) => api.createInvite(role, loc, note, tenant)}
                   revoke={(id) => api.revokeInvite(id, tenant)}
                   intro={<>Новый человек зарегистрируется по ссылке сам; тот, кто уже работает в другом ресторане,
                     примет приглашение своим входом — в шапке у него появится{mine.length > 1 ? <> «{tenantName}»</> : " ваше предприятие"}.</>} />
    </Stack>
  );
}

/** Точки-склады предприятия (ТЗ 16.4): у каждой свой склад, журнал и стоп-лист. */
function Locations() {
  const qc = useQueryClient();
  const locations = useQuery({ queryKey: ["admin-locations"], queryFn: () => api.locations() });
  const [rows, setRows] = useState<LocationRow[]>([blankLocation()]);
  const points = rowsState(rows);
  const [busy, setBusy] = useState(false);
  // Несколько точек разом (ТЗ 16.17): сервер создаёт все или ни одной
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createLocations(points.filled.map((x) => ({ name: x.name.trim(), openTime: x.open, closeTime: x.close })));
      notifyOk(r.ids.length > 1 ? `Создано точек: ${r.ids.length}` : `Точка создана: ${r.ids[0]}`, "Склад пуст — начните с поставки");
      setRows([blankLocation()]);
      qc.invalidateQueries({ queryKey: ["admin-locations"] });
      qc.invalidateQueries({ queryKey: ["config"] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Grid templateColumns={{ base: "1fr", xl: "1.4fr 1fr" }} gap="4" alignItems="start">
      <Section title="Точки">
        <Table.Root size="sm">
          <Table.Body>
            {locations.data?.map((l) => (
              <Table.Row key={l.id}>
                <Table.Cell>
                  <Text fontWeight="medium">{l.name}</Text>
                  <Text textStyle="xs" color="fg.muted"><Code size="sm">{l.id}</Code> · {l.openTime.slice(0, 5)}–{l.closeTime.slice(0, 5)}</Text>
                </Table.Cell>
                <Table.Cell hideBelow="md">
                  <Text textStyle="xs" color="fg.muted">Планшет с PIN:</Text>
                  <Code size="sm" wordBreak="break-all">{`${window.location.origin}/login?loc=${l.id}`}</Code>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Section>
      <Section title="Новые точки">
        <Stack gap="3">
          <Text textStyle="sm" color="fg.muted">Название, открытие и закрытие — строка на точку. Можно сразу несколько.</Text>
          <LocationRows rows={rows} onChange={setRows} withHours placeholders={["Набережная", "Вокзал", "Аэропорт"]} />
          <Button colorPalette="teal" loading={busy} onClick={create} disabled={!points.filled.length || points.duplicate}>
            {points.filled.length > 1 ? `Создать ${points.filled.length} ${plural(points.filled.length, ["точку", "точки", "точек"])}` : "Создать"}
          </Button>
          <Text textStyle="xs" color="fg.muted">ID точки — латиница из названия, он виден в адресе. Каталог общий для всех точек предприятия.</Text>
        </Stack>
      </Section>
    </Grid>
  );
}

const CONFIRM_WORD = "УДАЛИТЬ";

/**
 * Чистый лист для тестов (только демо-режим): удалить журнал и всё, что из него следует,
 * оставив справочники. В рабочем режиме журнал неизменяем — кнопки там нет.
 */
function CleanSlate() {
  const { config } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState("");
  const [startStock, setStartStock] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!config?.demoMode) {
    return (
      <Section title="Удалить все логи">
        <Text color="fg.muted">Доступно только в демо-режиме: в рабочем режиме журнал неизменяем.</Text>
      </Section>
    );
  }

  const close = () => { setOpen(false); setWord(""); };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.demoClean(word.trim(), startStock);
      notifyOk("Чистый лист", r.message);
      close();
      qc.invalidateQueries();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Удалить все логи">
      <Stack gap="4" maxW="3xl">
        <Text>Чистый лист для тестов: история склада начинается заново, без накопленных заказов, списаний и сигналов.</Text>
        <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
          <Box p="3" rounded="md" bg="red.subtle">
            <Text fontWeight="semibold" color="red.fg" mb="1">Удалится</Text>
            <Text textStyle="sm">Только этого предприятия: журнал движений и партии (склад станет пустым), поставки, заказы и отказы,
              заявки на списание, пересчёты, сигналы, подозрительные операции, аудит. У демо-предприятия ещё и демо-часы вернутся
              к реальному времени, а генератор событий выключится. Другие предприятия не затронуты.</Text>
          </Box>
          <Box p="3" rounded="md" bg="green.subtle">
            <Text fontWeight="semibold" color="green.fg" mb="1">Останется</Text>
            <Text textStyle="sm">Точки, сотрудники и их PIN, каталог и техкарты со всеми версиями, API-ключи, настройки и пороги.</Text>
          </Box>
        </SimpleGrid>
        <Checkbox.Root checked={startStock} onCheckedChange={(e) => setStartStock(!!e.checked)}>
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>Сразу принять стартовую поставку и приготовить заготовки — чтобы меню было рабочим</Checkbox.Label>
        </Checkbox.Root>
        <Box>
          <Button colorPalette="red" onClick={() => setOpen(true)}><LuTrash2 /> Удалить все логи</Button>
        </Box>
      </Stack>

      <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} role="alertdialog" placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header><Dialog.Title>Удалить все логи?</Dialog.Title></Dialog.Header>
              <Dialog.Body>
                <Stack gap="3">
                  <Text>Журнал, партии, заказы, поставки, списания, пересчёты, сигналы и аудит будут удалены безвозвратно.
                    {startStock ? " Затем примем стартовую поставку и приготовим заготовки." : " Склад останется пустым."}</Text>
                  <Field.Root>
                    <Field.Label>Чтобы подтвердить, введите {CONFIRM_WORD}</Field.Label>
                    <Input value={word} onChange={(e) => setWord(e.target.value)} placeholder={CONFIRM_WORD} autoComplete="off"
                           onKeyDown={(e) => e.key === "Enter" && word.trim() === CONFIRM_WORD && !busy && run()} />
                  </Field.Root>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="outline" onClick={close}>Отмена</Button>
                <Button colorPalette="red" loading={busy} disabled={word.trim() !== CONFIRM_WORD} onClick={run}>
                  Удалить навсегда
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Section>
  );
}
