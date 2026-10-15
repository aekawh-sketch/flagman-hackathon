import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import {
  Badge, Box, Button, Card, Center, Checkbox, Code, Container, Dialog, Field, Flex, Heading, HStack, Input, Portal, Spinner,
  Stack, Switch, Table, Tabs, Text, Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuArrowLeft, LuLogOut, LuPlus, LuShieldCheck, LuTrash2, LuUserPlus } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime } from "../format";
import type { PlatformSettings, PlatformTenant, TenantRequest } from "../types";
import { Empty, Loading, Section, Segments } from "../components/ui";
import { REQUEST_STATUS, useEnterTenant } from "../components/Tenants";
import { InviteLink, InvitePanel } from "../components/InvitePanel";
import { notifyError, notifyOk } from "../components/Toaster";
import { blankLocation, LocationRows, rowsState, type LocationRow } from "../components/LocationRows";

/**
 * Админка платформы (ТЗ 16.9): отдельная роль над всеми предприятиями — не роль внутри ресторана.
 * Заявки на создание предприятий, список предприятий и режимы платформы. То же доступно внешней
 * админке или CRM по ключу платформы — вкладка «Для CRM».
 */
export function PlatformPage() {
  const { me, refetchMe } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  if (me === undefined) return <Center h="100vh"><Spinner /></Center>;
  if (me === null) return <Navigate to="/login?next=/platform" replace />;
  const logout = async () => {
    await api.logout();
    qc.clear();
    refetchMe();
    navigate("/login");
  };
  return (
    <Box minH="100vh" bg="bg.subtle">
      <Flex as="header" h="14" px={{ base: "3", md: "6" }} align="center" gap="3" borderBottomWidth="1px" bg="bg.panel">
        <Box w="8" h="8" rounded="lg" bg="brand.solid" color="white" display="grid" placeItems="center"><LuShieldCheck /></Box>
        <Box flex="1" minW="0">
          <Text fontWeight="bold" lineHeight="1.1">Платформа</Text>
          <Text textStyle="xs" color="fg.muted" lineClamp={1}>{me.name}</Text>
        </Box>
        {me.tenantId !== 0 && (
          <Button size="sm" variant="ghost" onClick={() => navigate("/")}><LuArrowLeft /> <Box as="span" hideBelow="sm">К предприятию</Box></Button>
        )}
        <Button size="sm" variant="ghost" onClick={logout} aria-label="Выйти"><LuLogOut /></Button>
      </Flex>
      <Container maxW="6xl" py={{ base: "4", md: "6" }} px={{ base: "3", md: "6" }}>
        {!me.platformAdmin ? (
          <Empty title="Только для администратора платформы"
                 description="Роль над всеми предприятиями выдаётся настройкой сервера, а не внутри ресторана." />
        ) : (
          <>
            <Box mb="5">
              <Heading size="xl" letterSpacing="-0.01em">Администрирование платформы</Heading>
              <Text color="fg.muted" mt="1" textStyle="sm">
                Пользователи равноправны; роли — внутри предприятия. Здесь — заявки на новые предприятия и режимы платформы.
              </Text>
            </Box>
            <Tabs.Root defaultValue="requests" variant="line" lazyMount>
              <Tabs.List mb="4" overflowX="auto" whiteSpace="nowrap">
                <Tabs.Trigger value="requests">Заявки</Tabs.Trigger>
                <Tabs.Trigger value="tenants">Предприятия</Tabs.Trigger>
                <Tabs.Trigger value="settings">Настройки</Tabs.Trigger>
                <Tabs.Trigger value="crm">Для CRM</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="requests"><Requests /></Tabs.Content>
              <Tabs.Content value="tenants"><Tenants /></Tabs.Content>
              <Tabs.Content value="settings"><Settings /></Tabs.Content>
              <Tabs.Content value="crm"><Crm /></Tabs.Content>
            </Tabs.Root>
          </>
        )}
      </Container>
    </Box>
  );
}

function Requests() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("PENDING");
  const list = useQuery({ queryKey: ["platform-requests", status], queryFn: () => api.platformRequests(status || undefined),
    refetchInterval: 15_000 });
  const [deciding, setDeciding] = useState<{ r: TenantRequest; approve: boolean } | null>(null);
  return (
    <Section title="Заявки на создание предприятия"
             actions={<Segments value={status} onChange={setStatus}
                                items={[{ value: "PENDING", label: "Ждут решения" }, { value: "", label: "Все" }]} />}>
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <Empty title={status ? "Новых заявок нет" : "Заявок ещё не было"}
               description="Заявка появляется, когда пользователь создаёт предприятие в режиме «по заявке»." />
      ) : (
        <Stack gap="3">
          {list.data.map((r) => (
            <Card.Root key={r.id} variant="outline" size="sm">
              <Card.Body gap="2">
                <Flex justify="space-between" gap="3" align="start" wrap="wrap">
                  <Box minW="0">
                    <Text fontWeight="semibold">{r.name}</Text>
                    <Text textStyle="sm" color="fg.muted">
                      {r.userName} ({r.userLogin}) · точка «{r.locationName ?? r.name}» · подана {dateTime(r.createdAt)}
                    </Text>
                  </Box>
                  <Badge colorPalette={REQUEST_STATUS[r.status].color}>{REQUEST_STATUS[r.status].label}</Badge>
                </Flex>
                {r.comment && <Text textStyle="sm">«{r.comment}»</Text>}
                {r.status !== "PENDING" && r.decidedAt && (
                  <Text textStyle="xs" color="fg.muted">
                    {r.status === "CANCELED" ? "Отозвана заявителем" : r.decidedVia === "API" ? "Решение из внешней системы (API)" : r.decidedBy}
                    {" · "}{dateTime(r.decidedAt)}{r.decisionComment ? ` · «${r.decisionComment}»` : ""}
                    {r.tenantId ? ` · предприятие №${r.tenantId}` : r.status === "APPROVED" ? " · предприятие удалено" : ""}
                  </Text>
                )}
                {r.status === "PENDING" && (
                  <HStack gap="2">
                    <Button size="sm" colorPalette="teal" onClick={() => setDeciding({ r, approve: true })}>Одобрить</Button>
                    <Button size="sm" variant="outline" colorPalette="red" onClick={() => setDeciding({ r, approve: false })}>Отклонить</Button>
                  </HStack>
                )}
              </Card.Body>
            </Card.Root>
          ))}
        </Stack>
      )}
      {deciding && (
        <DecideDialog r={deciding.r} approve={deciding.approve} onClose={() => setDeciding(null)}
                      onDone={() => qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("platform-") })} />
      )}
    </Section>
  );
}

function DecideDialog({ r, approve, onClose, onDone }: { r: TenantRequest; approve: boolean; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await (approve ? api.platformApprove(r.id, comment.trim()) : api.platformReject(r.id, comment.trim()));
      notifyOk(approve ? `Предприятие «${r.name}» создано` : "Заявка отклонена",
        approve ? `${r.userName} — его админ` : "Заявитель увидит причину в своих заявках");
      onDone();
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>{approve ? "Одобрить" : "Отклонить"} «{r.name}»</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Text textStyle="sm" color="fg.muted">
                  {approve
                    ? `Предприятие создастся с первой точкой «${r.locationName ?? r.name}», ${r.userName} станет в нём админом.`
                    : `${r.userName} увидит отказ и комментарий и сможет подать новую заявку.`}
                </Text>
                <Field.Root>
                  <Field.Label>Комментарий {approve ? "(необязательно)" : "— причина"}</Field.Label>
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} autoFocus />
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button colorPalette={approve ? "teal" : "red"} loading={busy} onClick={submit}>
                {approve ? "Одобрить и создать" : "Отклонить"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function Tenants() {
  const list = useQuery({ queryKey: ["platform-tenants"], queryFn: api.platformTenants });
  const deleted = useQuery({ queryKey: ["platform-deleted"], queryFn: api.platformDeletions });
  const [deleting, setDeleting] = useState<PlatformTenant | null>(null);
  const [inviting, setInviting] = useState<PlatformTenant | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <Stack gap="4">
    <Section title="Предприятия на платформе"
             actions={<Button size="sm" colorPalette="teal" onClick={() => setCreating(true)}><LuPlus /> Создать предприятие</Button>}>
      {list.isLoading ? <Loading /> : (
        <Table.ScrollArea>
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>№</Table.ColumnHeader>
                <Table.ColumnHeader>Название</Table.ColumnHeader>
                <Table.ColumnHeader>Владелец</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Сотрудников</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Точек</Table.ColumnHeader>
                <Table.ColumnHeader>Создано</Table.ColumnHeader>
                <Table.ColumnHeader />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.data?.map((t) => (
                <Table.Row key={t.id}>
                  <Table.Cell>{t.id}</Table.Cell>
                  <Table.Cell fontWeight="medium">{t.name}</Table.Cell>
                  <Table.Cell>
                    {t.owner ?? (t.ownerInvited
                      ? <Badge colorPalette="blue" variant="subtle">ждёт по ссылке</Badge>
                      : <Text as="span" color="fg.muted">—</Text>)}
                  </Table.Cell>
                  <Table.Cell textAlign="end">{t.members}</Table.Cell>
                  <Table.Cell textAlign="end">{t.locations}</Table.Cell>
                  <Table.Cell whiteSpace="nowrap">{t.createdAt ? dateTime(t.createdAt) : "—"}</Table.Cell>
                  <Table.Cell textAlign="end">
                    <HStack justify="end" gap="1">
                      <Button size="xs" variant="ghost" onClick={() => setInviting(t)}><LuUserPlus /> Пригласить</Button>
                      {t.demo ? <Badge variant="outline">демо</Badge> : (
                        <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setDeleting(t)}>
                          <LuTrash2 /> Удалить
                        </Button>
                      )}
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
    </Section>
    {!!deleted.data?.length && (
      <Section title="Удалённые предприятия">
        <Stack gap="2">
          {deleted.data.map((d) => (
            <Box key={d.id} borderWidth="1px" rounded="md" p="3">
              <Flex justify="space-between" gap="3" wrap="wrap">
                <Text fontWeight="medium">№{d.tenantId} «{d.name}»{d.owner ? ` · владелец ${d.owner}` : ""}</Text>
                <Text textStyle="sm" color="fg.muted">{dateTime(d.deletedAt)}</Text>
              </Flex>
              <Text textStyle="xs" color="fg.muted" mt="1">
                {d.deletedVia === "API" ? "Из внешней системы (API)" : `Удалил ${d.deletedBy ?? "—"}`}
                {" · "}точек {d.stats.locations ?? 0}, сотрудников {d.stats.memberships ?? 0}, заказов {d.stats.orders ?? 0},
                {" "}записей журнала {d.stats.movements ?? 0}
              </Text>
              {d.reason && <Text textStyle="sm" mt="1">«{d.reason}»</Text>}
            </Box>
          ))}
        </Stack>
      </Section>
    )}
    {deleting && <DeleteTenantDialog t={deleting} onClose={() => setDeleting(null)} />}
    {inviting && <InvitesDialog t={inviting} onClose={() => setInviting(null)} />}
    {creating && <CreatePlatformTenantDialog onClose={() => setCreating(false)} />}
    </Stack>
  );
}

/**
 * Предприятие от платформы — например, для клиента: создатель в нём не работает, владельцу уходит ссылка
 * с ролью «Админ». Галочка «я тоже админ» — если администратор платформы сам будет его настраивать.
 */
function CreatePlatformTenantDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const enter = useEnterTenant();
  const [name, setName] = useState("");
  const [locations, setLocations] = useState<LocationRow[]>([blankLocation()]);
  const points = rowsState(locations);
  const [join, setJoin] = useState(false);
  const [ownerLink, setOwnerLink] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ tenantId: number; name: string; link: string | null; points: number } | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      const t = await api.platformCreateTenant(name.trim(), points.filled.map((r) => r.name.trim()), join);
      const inv = ownerLink ? await api.platformInvite(t.tenantId, "ADMIN", null, "Владелец") : null;
      setDone({ tenantId: t.tenantId, name: t.name, link: inv ? `${window.location.origin}/invite/${inv.token}` : null,
        points: Math.max(1, points.filled.length) });
      qc.invalidateQueries({ queryKey: ["platform-tenants"] });
      notifyOk(`Предприятие «${t.name}» создано`, join ? "Вы его админ" : undefined);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>{done ? `«${done.name}» создано` : "Новое предприятие"}</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              {done ? (
                <Stack gap="3">
                  <Text textStyle="sm" color="fg.muted">
                    {done.points > 1 ? `Точек-складов: ${done.points}.` : "Точка-склад уже есть."} {done.link
                      ? "Отправьте ссылку владельцу: по ней он зарегистрируется (или войдёт) и станет админом и владельцем предприятия."
                      : "Пригласить людей можно кнопкой «Пригласить» в списке предприятий."}
                  </Text>
                  {done.link && <InviteLink link={done.link} />}
                  {done.link && (
                    <Text textStyle="xs" color="fg.muted">
                      Проверяете сами — открывайте ссылку в окне инкогнито: в этом браузере вы вошли как администратор
                      платформы, и приняв ссылку, админом станете вы.
                    </Text>
                  )}
                </Stack>
              ) : (
                <Stack gap="4">
                  <Field.Root required>
                    <Field.Label>Название</Field.Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Кофейня «Северная»" autoFocus />
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Точки-склады</Field.Label>
                    <LocationRows rows={locations} onChange={setLocations} />
                    <Field.HelperText>Первая — основная. Не указали ни одной — назовём так же, как предприятие; ещё точки админ добавит в «Админке».</Field.HelperText>
                  </Field.Root>
                  <Checkbox.Root checked={ownerLink} onCheckedChange={(e) => setOwnerLink(!!e.checked)}>
                    <Checkbox.HiddenInput /><Checkbox.Control />
                    <Checkbox.Label>Сразу выпустить ссылку для владельца (роль «Админ»)</Checkbox.Label>
                  </Checkbox.Root>
                  <Checkbox.Root checked={join} onCheckedChange={(e) => setJoin(!!e.checked)}>
                    <Checkbox.HiddenInput /><Checkbox.Control />
                    <Checkbox.Label>Я тоже админ в нём — буду настраивать сам</Checkbox.Label>
                  </Checkbox.Root>
                </Stack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              {done ? (
                <>
                  {join && (
                    <Button variant="outline" onClick={() => { enter(done.tenantId).catch(notifyError); }}>Открыть предприятие</Button>
                  )}
                  <Button colorPalette="teal" onClick={onClose}>Готово</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={onClose}>Отмена</Button>
                  <Button colorPalette="teal" loading={busy} disabled={!name.trim() || points.duplicate} onClick={submit}>Создать</Button>
                </>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Пригласить людей в любое предприятие платформы — та же форма, что у админа предприятия. */
function InvitesDialog({ t, onClose }: { t: PlatformTenant; onClose: () => void }) {
  const locations = useQuery({ queryKey: ["platform-locations", t.id], queryFn: () => api.platformLocations(t.id) });
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} placement="center" size="lg" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Пригласить в «{t.name}»</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              <InvitePanel stacked queryKey={["platform-invites", t.id]} locations={locations.data}
                           defaultRole={t.members === 0 ? "ADMIN" : "COOK"}
                           list={() => api.platformInvites(t.id)}
                           create={(role, loc, note) => api.platformInvite(t.id, role, loc, note)}
                           revoke={(id) => api.platformRevokeInvite(t.id, id)}
                           intro={t.members === 0
                             ? "В предприятии пока никого нет — начните с владельца: роль «Админ», дальше он пригласит команду сам."
                             : "Новый человек зарегистрируется по ссылке сам; уже зарегистрированный примет приглашение своим входом."} />
            </Dialog.Body>
            <Dialog.Footer><Button variant="outline" onClick={onClose}>Закрыть</Button></Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Удаление предприятия — безвозвратно, поэтому подтверждение — ввести его название точно, как на GitHub:
 * случайный клик по кнопке ничего не сотрёт.
 */
function DeleteTenantDialog({ t, onClose }: { t: PlatformTenant; onClose: () => void }) {
  const { me, refetchMe } = useSession();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const exact = confirm.trim() === t.name;
  const submit = async () => {
    setBusy(true);
    try {
      await api.platformDeleteTenant(t.id, confirm.trim(), reason.trim());
      notifyOk(`Предприятие «${t.name}» удалено`, "След остался в «Удалённых предприятиях»");
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("platform-") });
      // Если вы сами в нём работали — переключатель предприятий в шапке должен это узнать
      if (me?.tenants.some((m) => m.tenantId === t.id)) refetchMe();
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} placement="center" role="alertdialog">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header><Dialog.Title>Удалить «{t.name}»?</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                <Box p="3" rounded="md" bg="red.subtle" color="red.fg" textStyle="sm">
                  Безвозвратно: точки ({t.locations}), каталог и техкарты, членства сотрудников ({t.members}), API-ключи,
                  журнал движений, поставки, заказы, заявки и фото. Учётки людей останутся — без этого предприятия.
                </Box>
                <Field.Root>
                  <Field.Label>Причина (останется в истории удалений)</Field.Label>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
                </Field.Root>
                <Field.Root invalid={!!confirm && !exact}>
                  <Field.Label>Для подтверждения введите название: <b>{t.name}</b></Field.Label>
                  <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus autoComplete="off" />
                  {!!confirm && !exact && <Field.ErrorText>Название не совпадает</Field.ErrorText>}
                </Field.Root>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button colorPalette="red" loading={busy} disabled={!exact} onClick={submit}>
                <LuTrash2 /> Удалить навсегда
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function Settings() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["platform-settings"], queryFn: api.platformSettings });
  const save = async (next: PlatformSettings) => {
    try {
      qc.setQueryData(["platform-settings"], await api.platformUpdateSettings(next));
      // Режим показывают и экраны входа/создания — их настройки перечитываются.
      qc.invalidateQueries({ queryKey: ["config"] });
      notifyOk("Сохранено");
    } catch (e) {
      notifyError(e);
    }
  };
  if (!s.data) return <Loading rows={2} />;
  const v = s.data;
  return (
    <Stack gap="4">
      <Section title="Создание предприятия">
        <Text textStyle="sm" color="fg.muted">
          Предприятия создаёт только администратор платформы: сам — во вкладке «Предприятия», или одобрив заявку
          человека без предприятия (здесь или во внешней CRM). Админы, управляющие и другие сотрудники предприятий
          новых не создают и заявок не подают.
        </Text>
      </Section>
      <Section title="Регистрация">
        <Switch.Root checked={v.registrationOpen} onCheckedChange={(e) => save({ ...v, registrationOpen: e.checked })}>
          <Switch.HiddenInput />
          <Switch.Control><Switch.Thumb /></Switch.Control>
          <Switch.Label>Открытая регистрация</Switch.Label>
        </Switch.Root>
        <Text textStyle="sm" color="fg.muted" mt="2">
          Выключена — новые люди попадают на платформу только по ссылке-приглашению от предприятия.
        </Text>
      </Section>
    </Stack>
  );
}

/** Как вести заявки из внешней админки или CRM: те же методы, ключ платформы в заголовке, веб-хук о новой заявке. */
function Crm() {
  const rows: [string, string][] = [
    ["GET", "/api/platform/tenant-requests?status=PENDING"],
    ["POST", "/api/platform/tenant-requests/{id}/approve  {\"comment\": \"…\"}"],
    ["POST", "/api/platform/tenant-requests/{id}/reject  {\"comment\": \"…\"}"],
    ["GET", "/api/platform/tenants"],
    ["POST", "/api/platform/tenants/{id}/delete  {\"confirm\": \"<точное название>\", \"reason\": \"…\"}"],
    ["GET", "/api/platform/tenants/deleted"],
    ["GET / PUT", "/api/platform/settings  {\"tenantCreation\": \"APPROVAL\", \"registrationOpen\": true}"],
  ];
  return (
    <Stack gap="4">
      <Section title="Внешняя админка или CRM">
        <Stack gap="3" textStyle="sm">
          <Text>
            Заявки можно вести не здесь, а во внешней системе. Она вызывает те же методы с заголовком{" "}
            <Code>X-Platform-Key</Code> — ключ задаётся на сервере переменной <Code>PLATFORM_API_KEY</Code>.
            Решение из CRM помечается в заявке как «из внешней системы (API)».
          </Text>
          <Stack gap="1">
            {rows.map(([m, p]) => (
              <HStack key={p} align="start" gap="2">
                <Badge variant="outline" minW="16" justifyContent="center">{m}</Badge>
                <Code wordBreak="break-all">{p}</Code>
              </HStack>
            ))}
          </Stack>
          <Text>
            О новой заявке система сообщает сама: POST на адрес из <Code>PLATFORM_WEBHOOK_URL</Code> с телом{" "}
            <Code>{"{\"event\": \"tenant_request.created\", \"request\": {…}}"}</Code>.
          </Text>
          <Text>
            Администраторы платформы — логины из <Code>PLATFORM_ADMINS</Code> (через запятую): роль выдаётся при старте сервера.
            Полное описание — в <a href="/swagger-ui/index.html" style={{ textDecoration: "underline" }}>документации API</a>, раздел «Платформа».
          </Text>
        </Stack>
      </Section>
    </Stack>
  );
}
