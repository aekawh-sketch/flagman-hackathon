import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  Badge, Box, Button, Card, Center, Dialog, Field, HStack, Input, Portal, Separator, Stack, Text, Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuBuilding2, LuLogOut, LuMailOpen, LuPlus, LuShieldCheck } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, ROLE } from "../format";
import type { Me, TenantRequest } from "../types";
import { notifyError, notifyOk } from "./Toaster";

/**
 * Войти в предприятие и открыть его «Админку» с первыми шагами — сразу после создания или одобрения заявки:
 * новое предприятие пустое, начинать надо с меню и сотрудников.
 */
export function useEnterTenant() {
  const { switchTenant, applyMe } = useSession();
  const navigate = useNavigate();
  return async (target: Me | number) => {
    let m: Me;
    if (typeof target === "number") {
      m = await switchTenant(target);
    } else {
      applyMe(target);
      m = target;
    }
    const loc = m.locationId ?? (await api.config()).locations[0]?.id;
    navigate(loc ? `/${loc}/admin?welcome=1` : "/");
    return m;
  };
}

/**
 * Заявка на предприятие (ТЗ 16.14): предприятия создаёт только администратор платформы — человек без предприятия
 * просит его, после одобрения становится админом нового. Администратору платформы сервер создаёт сразу.
 */
export function CreateTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useSession();
  const instant = !!me?.platformAdmin;
  const enter = useEnterTenant();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.createTenant(name.trim(), location.trim(), comment.trim() || undefined);
      if (r.status === "CREATED") {
        await enter(r.me);
        notifyOk(`Предприятие «${r.me.tenantName}» создано`, "Вы его админ. Начните с меню и сотрудников");
      } else {
        qc.invalidateQueries({ queryKey: ["my-tenant-requests"] });
        notifyOk("Заявка отправлена администратору платформы", "Когда её одобрят, предприятие появится в списке");
      }
      onClose();
      setName("");
      setLocation("");
      setComment("");
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
            <Dialog.Header><Dialog.Title>{instant ? "Новое предприятие" : "Заявка на предприятие"}</Dialog.Title></Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Text textStyle="sm" color="fg.muted">
                  Свой склад, каталог, сотрудники и журнал — данные других предприятий здесь не видны. Вы станете админом.
                  {!instant && " Предприятия создаёт администратор платформы — оно появится, когда он одобрит заявку."}
                </Text>
                <Field.Root required>
                  <Field.Label>Название</Field.Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Кофейня «Северная»" autoFocus />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Первая точка-склад</Field.Label>
                  <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Центр" />
                  <Field.HelperText>Не указали — назовём так же, как предприятие. Ещё точки — в «Админке».</Field.HelperText>
                </Field.Root>
                {!instant && (
                  <Field.Root>
                    <Field.Label>Комментарий для администратора платформы</Field.Label>
                    <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
                              placeholder="Кто вы, адрес, сколько точек" />
                  </Field.Root>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>Отмена</Button>
              <Button colorPalette="teal" loading={busy} disabled={!name.trim()} onClick={submit}>
                {instant ? "Создать" : "Отправить заявку"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

export const REQUEST_STATUS: Record<TenantRequest["status"], { label: string; color: string }> = {
  PENDING: { label: "ждёт решения", color: "orange" },
  APPROVED: { label: "одобрена", color: "green" },
  REJECTED: { label: "отклонена", color: "red" },
  CANCELED: { label: "отозвана", color: "gray" },
};

/** Из ссылки-приглашения или просто кода — токен: «…/invite/abc» → «abc». */
function inviteToken(raw: string): string {
  const s = raw.trim();
  const m = s.match(/\/invite\/([^/?#\s]+)/);
  return m ? m[1] : s;
}

/**
 * Человек вошёл, но ещё ни в одном предприятии (ТЗ 16.9, 16.14): он принимает приглашение или просит
 * администратора платформы создать ему предприятие — заявкой.
 */
export function NoTenantPage() {
  const { me, switchTenant } = useSession();
  const enter = useEnterTenant();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [create, setCreate] = useState(false);
  const [invite, setInvite] = useState("");
  // Пока заявка ждёт — переспрашиваем: одобрят, и кнопка «Открыть» появится сама.
  const requests = useQuery({
    queryKey: ["my-tenant-requests"], queryFn: api.myTenantRequests,
    refetchInterval: (q) => q.state.data?.some((r) => r.status === "PENDING") ? 10_000 : false,
  });
  const pending = requests.data?.some((r) => r.status === "PENDING");
  // Заявку одобрили — сразу в новое предприятие, в его «Админку» с первыми шагами.
  const approved = requests.data?.find((r) => r.status === "APPROVED" && r.tenantId
    && !me?.tenants.some((t) => t.tenantId === r.tenantId));
  const entered = useRef(false);
  useEffect(() => {
    if (!approved?.tenantId || entered.current) return;
    entered.current = true;
    enter(approved.tenantId)
      .then(() => notifyOk(`Заявка одобрена — «${approved.name}» ваше`, "Вы админ. Начните с меню и сотрудников"))
      .catch((e) => { entered.current = false; notifyError(e); });
  }, [approved, enter]);
  const logout = async () => {
    await api.logout();
    window.location.href = "/login";
  };
  const open = async (tenantId: number) => {
    try {
      await switchTenant(tenantId);
      navigate("/");
    } catch (e) {
      notifyError(e);
    }
  };
  const cancel = async (id: number) => {
    try {
      await api.cancelTenantRequest(id);
      qc.invalidateQueries({ queryKey: ["my-tenant-requests"] });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Center minH="100vh" px="4" py="8" bg="bg.subtle">
      <Card.Root maxW="lg" w="full">
        <Card.Body gap="5">
          <Box color="teal.fg" fontSize="3xl"><LuBuilding2 /></Box>
          <Box>
            <Text textStyle="xl" fontWeight="semibold">{me?.name}, вы пока не работаете ни в одном предприятии</Text>
            <Text color="fg.muted" textStyle="sm" mt="1">
              Роль появляется внутри предприятия: по приглашению — та, что выбрал админ; в своём — вы админ.
            </Text>
          </Box>

          {!!me?.tenants.length && (
            <Stack gap="2">
              <Text fontWeight="medium">Ваши предприятия</Text>
              {me.tenants.map((t) => (
                <Button key={t.tenantId} variant="outline" justifyContent="space-between" onClick={() => open(t.tenantId)}>
                  {t.tenantName}<Text as="span" color="fg.muted" textStyle="xs">{ROLE[t.role]}</Text>
                </Button>
              ))}
            </Stack>
          )}

          <Stack gap="2">
            <HStack><LuMailOpen /><Text fontWeight="medium">Принять приглашение</Text></HStack>
            <Text textStyle="sm" color="fg.muted">Вставьте ссылку-приглашение от администратора ресторана.</Text>
            <HStack as="form" onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              if (inviteToken(invite)) navigate(`/invite/${encodeURIComponent(inviteToken(invite))}`);
            }}>
              <Input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="https://…/invite/…" />
              <Button type="submit" colorPalette="teal" variant="outline" disabled={!invite.trim()}>Открыть</Button>
            </HStack>
          </Stack>

          <Separator />

          <Stack gap="2">
            <HStack><LuPlus /><Text fontWeight="medium">Своё предприятие — через администратора платформы</Text></HStack>
            <Text textStyle="sm" color="fg.muted">
              Предприятия создаёт администратор платформы. Подайте заявку — после одобрения вы станете админом
              предприятия и пригласите сотрудников.
            </Text>
            <Box>
              <Button colorPalette="teal" disabled={pending} onClick={() => setCreate(true)}>Подать заявку</Button>
            </Box>
          </Stack>

          {!!requests.data?.length && (
            <Stack gap="2">
              <Text fontWeight="medium">Мои заявки</Text>
              {requests.data.map((r) => (
                <Box key={r.id} borderWidth="1px" rounded="md" p="3">
                  <HStack justify="space-between" align="start" gap="3">
                    <Box minW="0">
                      <Text fontWeight="medium" lineClamp={1}>{r.name}</Text>
                      <Text textStyle="xs" color="fg.muted">подана {dateTime(r.createdAt)}</Text>
                    </Box>
                    <Badge colorPalette={REQUEST_STATUS[r.status].color}>{REQUEST_STATUS[r.status].label}</Badge>
                  </HStack>
                  {r.decisionComment && <Text textStyle="sm" mt="2">«{r.decisionComment}»</Text>}
                  {r.status === "PENDING" && (
                    <Button size="xs" variant="ghost" mt="2" onClick={() => cancel(r.id)}>Отозвать</Button>
                  )}
                  {r.status === "APPROVED" && !r.tenantId && (
                    <Text textStyle="xs" color="fg.muted" mt="1">Предприятие позже удалено администратором платформы</Text>
                  )}
                  {r.status === "APPROVED" && r.tenantId && (
                    <Button size="xs" colorPalette="teal" mt="2" onClick={() => open(r.tenantId!)}>Открыть предприятие</Button>
                  )}
                </Box>
              ))}
            </Stack>
          )}

          <HStack gap="2" wrap="wrap">
            {me?.platformAdmin && (
              <Button variant="outline" onClick={() => navigate("/platform")}><LuShieldCheck /> Админка платформы</Button>
            )}
            <Button variant="ghost" onClick={logout}><LuLogOut /> Выйти</Button>
          </HStack>
        </Card.Body>
      </Card.Root>
      <CreateTenantDialog open={create} onClose={() => setCreate(false)} />
    </Center>
  );
}
