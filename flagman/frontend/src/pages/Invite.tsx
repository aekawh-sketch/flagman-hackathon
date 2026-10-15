import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Alert, Badge, Box, Button, Card, Center, Field, Input, Spinner, Stack, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuMailOpen } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, ROLE } from "../format";
import { notifyError, notifyOk } from "../components/Toaster";

/**
 * Ссылка-приглашение (ТЗ 16.4): новый человек регистрируется, уже зарегистрированный — принимает
 * приглашение своим входом и получает ещё одно предприятие в переключателе.
 * Открыл ссылку не тот, кто вошёл в этом браузере (частый случай — администратор платформы проверяет
 * ссылку владельца), — можно выйти и зарегистрировать нового человека.
 */
export function InvitePage() {
  const { token = "" } = useParams();
  const { me, applyMe } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.inviteInfo(token), retry: false });
  const [form, setForm] = useState({ login: "", name: "", password: "", pin: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const done = (m: Awaited<ReturnType<typeof api.acceptInvite>>) => {
    applyMe(m);
    notifyOk(`Добро пожаловать в «${m.tenantName}»`, `Ваша роль — ${ROLE[m.role as keyof typeof ROLE] ?? m.role}`);
    navigate("/");
  };
  const accept = async () => {
    setBusy(true);
    try {
      done(await api.acceptInvite(token));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    qc.setQueryData(["me"], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" && q.queryKey[0] !== "invite" });
  };
  const register = async () => {
    setBusy(true);
    try {
      done(await api.registerByInvite(token, { ...form, pin: form.pin || undefined }));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const i = info.data;
  const usable = i?.status === "ACTIVE";
  // Ссылка владельца, а вошёл администратор платформы: принять её — значит стать админом чужого предприятия
  const ownerLinkForPlatform = !!me?.platformAdmin && i?.role === "ADMIN";
  return (
    <Center minH="100vh" px="4" py="8" bg="bg.subtle">
      <Card.Root maxW="md" w="full">
        <Card.Body gap="4">
          <Box color="teal.fg" fontSize="3xl"><LuMailOpen /></Box>
          {info.isLoading && <Spinner />}
          {info.isError && <Text>Приглашение не найдено. Проверьте ссылку или попросите новую.</Text>}
          {i && (
            <>
              <Box>
                <Text textStyle="xl" fontWeight="semibold">Вас приглашают в «{i.tenantName}»</Text>
                <Text color="fg.muted" textStyle="sm" mt="1">
                  Ваша роль — <b>{i.role === "ADMIN" ? "админ предприятия" : ROLE[i.role]}</b>
                  {i.locationName ? <> · точка «{i.locationName}»</> : " · все точки"}
                </Text>
                <Text color="fg.muted" textStyle="sm">Приглашает: {i.invitedBy}</Text>
                {usable
                  ? <Text color="fg.muted" textStyle="xs" mt="1">Ссылка действует до {dateTime(i.expiresAt)}</Text>
                  : <Badge mt="2" colorPalette="red">{{ ACCEPTED: "уже использовано", REVOKED: "отозвано",
                      EXPIRED: "срок истёк", ACTIVE: "" }[i.status]}</Badge>}
              </Box>
              {usable && me && (ownerLinkForPlatform ? (
                <Stack gap="3">
                  <Alert.Root status="warning">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>Вы вошли как администратор платформы</Alert.Title>
                      <Alert.Description>
                        Эта ссылка — для владельца: кто её примет, станет админом «{i.tenantName}».
                        Выйдите и зарегистрируйте владельца — или откройте ссылку в окне инкогнито,
                        тогда консоль платформы останется открытой.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert.Root>
                  <Button colorPalette="teal" onClick={signOut}>Выйти и зарегистрировать владельца</Button>
                  <Button variant="ghost" size="sm" loading={busy} onClick={accept}>Всё-таки принять самому</Button>
                </Stack>
              ) : (
                <Stack gap="3">
                  <Text textStyle="sm">Вы вошли как <b>{me.name}</b>. Предприятие добавится в переключатель в шапке.</Text>
                  <Button colorPalette="teal" loading={busy} onClick={accept}>Принять как {me.name}</Button>
                  <Button variant="ghost" size="sm" onClick={signOut}>Это не я — выйти и зарегистрироваться</Button>
                </Stack>
              ))}
              {usable && me === null && (
                <Stack gap="3">
                  <Field.Root required>
                    <Field.Label>Имя и фамилия</Field.Label>
                    <Input value={form.name} onChange={set("name")} placeholder="Мария Белова" autoComplete="name" />
                  </Field.Root>
                  <Field.Root required>
                    <Field.Label>Логин</Field.Label>
                    <Input value={form.login} onChange={set("login")} placeholder="maria.b" autoComplete="username" />
                  </Field.Root>
                  <Field.Root required>
                    <Field.Label>Пароль</Field.Label>
                    <Input type="password" value={form.password} onChange={set("password")} autoComplete="new-password" />
                    <Field.HelperText>Не короче 6 символов</Field.HelperText>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>PIN для списаний</Field.Label>
                    <Input inputMode="numeric" maxLength={6} value={form.pin} onChange={set("pin")} placeholder="4–6 цифр" />
                  </Field.Root>
                  <Button colorPalette="teal" loading={busy} onClick={register}
                          disabled={!form.login || !form.name || form.password.length < 6}>
                    Зарегистрироваться
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}>
                    У меня уже есть учётная запись — войти
                  </Button>
                </Stack>
              )}
            </>
          )}
        </Card.Body>
      </Card.Root>
    </Center>
  );
}
