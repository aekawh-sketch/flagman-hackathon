import { useState } from "react";
import { useNavigate } from "react-router";
import {
  Alert, Box, Button, Card, Center, Field, Heading, HStack, Input, Progress, SimpleGrid, Stack, Tabs, Text,
} from "@chakra-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { LuChefHat, LuGauge, LuPackageCheck, LuSettings, LuShieldCheck } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { ROLE } from "../format";
import type { Me, Role } from "../types";
import { notifyError } from "../components/Toaster";
import { HOME } from "../home";

const DEMO_ROLES: { role: Role; icon: React.ReactNode; text: string }[] = [
  { role: "MANAGER", icon: <LuGauge />, text: "Дашборд, заявки на списание, аналитика, подозрительные операции" },
  { role: "COOK", icon: <LuChefHat />, text: "Кухня: какую партию брать, заготовки, вскрытие упаковок" },
  { role: "STOREKEEPER", icon: <LuPackageCheck />, text: "Приёмка поставок, этикетки партий, инвентаризация" },
  { role: "ADMIN", icon: <LuSettings />, text: "Демо-панель: ускорение времени, сценарии, сброс данных" },
];

/** Над всеми предприятиями (ТЗ 16.9): заявки на создание, список предприятий, режимы платформы. */
const DEMO_PLATFORM = { icon: <LuShieldCheck />, title: "Администратор платформы",
  text: "Заявки на новые предприятия, режим «сразу / по заявке», открытая регистрация" };

export function LoginPage() {
  const { config } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const done = (me: Me) => {
    qc.setQueryData(["me"], me);
    // Точки и данные — того предприятия, куда вошли (ТЗ 16.4): старое не должно мелькнуть.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/")) {
      navigate(next);
    } else if (me.tenantId && me.locationId) {
      navigate(`/${me.locationId}/${HOME[me.role as keyof typeof HOME]}`);
    } else {
      navigate("/");    // точку выберет главная, когда загрузятся точки предприятия
    }
  };
  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    try {
      done(await fn());
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const seeding = config?.seedStatus?.startsWith("seeding");

  return (
    <Center minH="100vh" px="4" py="10" bg="bg.subtle">
      <Stack gap="6" w="full" maxW="4xl">
        <Box textAlign="center">
          <Heading size="3xl" letterSpacing="-0.02em">Склад ресторана</Heading>
          <Text color="fg.muted" mt="2">
            Партии и сроки годности · стоп-лист · горячие предложения · защита от умышленных списаний
          </Text>
          {config && <Text color="fg.subtle" textStyle="sm" mt="1">{config.restaurantName}</Text>}
        </Box>

        {seeding && (
          <Alert.Root status="info">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Готовим демо-данные</Alert.Title>
              <Alert.Description>{config?.seedStatus} — прогоняем неделю работы ресторана.</Alert.Description>
              <Progress.Root value={null} size="xs" mt="2"><Progress.Track><Progress.Range /></Progress.Track></Progress.Root>
            </Alert.Content>
          </Alert.Root>
        )}

        <Card.Root>
          <Card.Body>
            {/* Ключ — от настроек: пока они не пришли, демо-режим неизвестен; пришли — выбираем вкладку заново. */}
            <Tabs.Root key={config ? "ready" : "loading"} defaultValue={config?.demoMode ? "demo" : "password"} variant="enclosed" fitted>
              {/* На телефоне — короткие подписи, чтобы вкладки не переносились на две строки. */}
              <Tabs.List whiteSpace="nowrap">
                {config?.demoMode && <Tabs.Trigger value="demo"><span>Демо<Box as="span" hideBelow="sm">-вход</Box></span></Tabs.Trigger>}
                <Tabs.Trigger value="password"><Box as="span" hideFrom="sm">Пароль</Box><Box as="span" hideBelow="sm">Логин и пароль</Box></Tabs.Trigger>
                {config?.registrationOpen && (
                  <Tabs.Trigger value="signup"><Box as="span" hideFrom="sm">Новый</Box><Box as="span" hideBelow="sm">Регистрация</Box></Tabs.Trigger>
                )}
              </Tabs.List>

              {config?.demoMode && (
                <Tabs.Content value="demo" pt="5">
                  <Text color="fg.muted" textStyle="sm" mb="4">
                    Войдите под любой ролью — каждая видит свою работу. Пароль всех демо-учёток: <b>demo1234</b>.
                  </Text>
                  <SimpleGrid columns={{ base: 1, sm: 2 }} gap="3">
                    {DEMO_ROLES.map((r) => (
                      <Card.Root key={r.role} variant="outline" cursor="pointer" _hover={{ borderColor: "brand.solid" }}
                                 onClick={() => !busy && !seeding && run(() => api.demoLogin(r.role))}>
                        <Card.Body gap="2">
                          <HStack>
                            <Box color="brand.fg" fontSize="xl">{r.icon}</Box>
                            <Text fontWeight="semibold">{ROLE[r.role]}</Text>
                          </HStack>
                          <Text textStyle="sm" color="fg.muted">{r.text}</Text>
                        </Card.Body>
                      </Card.Root>
                    ))}
                    <Card.Root variant="outline" cursor="pointer" _hover={{ borderColor: "brand.solid" }} gridColumn={{ sm: "span 2" }}
                               onClick={() => !busy && !seeding && run(() => api.demoLogin("PLATFORM"))}>
                      <Card.Body gap="2">
                        <HStack>
                          <Box color="brand.fg" fontSize="xl">{DEMO_PLATFORM.icon}</Box>
                          <Text fontWeight="semibold">{DEMO_PLATFORM.title}</Text>
                        </HStack>
                        <Text textStyle="sm" color="fg.muted">{DEMO_PLATFORM.text}</Text>
                      </Card.Body>
                    </Card.Root>
                  </SimpleGrid>
                </Tabs.Content>
              )}

              <Tabs.Content value="password" pt="5">
                <PasswordForm busy={busy} onSubmit={(l, p) => run(() => api.login(l, p))} />
              </Tabs.Content>

              {config?.registrationOpen && (
                <Tabs.Content value="signup" pt="5">
                  <SignUpForm busy={busy} onSubmit={(l, n, p) => run(() => api.signUp(l, n, p))} />
                </Tabs.Content>
              )}
            </Tabs.Root>
          </Card.Body>
        </Card.Root>
        <Text textAlign="center" textStyle="xs" color="fg.subtle">
          <a href="/swagger-ui/index.html" style={{ textDecoration: "underline" }}>Документация API</a>
        </Text>
      </Stack>
    </Center>
  );
}

function PasswordForm({ busy, onSubmit }: { busy: boolean; onSubmit: (login: string, password: string) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  return (
    <Stack as="form" gap="4" maxW="sm" mx="auto"
           onSubmit={(e: React.FormEvent) => { e.preventDefault(); onSubmit(login, password); }}>
      <Field.Root>
        <Field.Label>Логин</Field.Label>
        <Input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" />
      </Field.Root>
      <Field.Root>
        <Field.Label>Пароль</Field.Label>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
               autoComplete="current-password" />
      </Field.Root>
      <Button type="submit" colorPalette="teal" loading={busy}>Войти</Button>
    </Stack>
  );
}

/**
 * Открытая регистрация (ТЗ 16.9): учётная запись без предприятия. Дальше человек принимает приглашение
 * или подаёт заявку на своё предприятие администратору платформы — роль у него появится уже внутри предприятия.
 */
function SignUpForm({ busy, onSubmit }: { busy: boolean; onSubmit: (login: string, name: string, password: string) => void }) {
  const [form, setForm] = useState({ name: "", login: "", password: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Stack as="form" gap="4" maxW="sm" mx="auto"
           onSubmit={(e: React.FormEvent) => { e.preventDefault(); onSubmit(form.login.trim(), form.name.trim(), form.password); }}>
      <Text textStyle="sm" color="fg.muted">
        После регистрации — принять приглашение в ресторан или подать заявку на своё предприятие.
      </Text>
      <Field.Root required>
        <Field.Label>Имя и фамилия</Field.Label>
        <Input value={form.name} onChange={set("name")} placeholder="Мария Белова" autoComplete="name" />
      </Field.Root>
      <Field.Root required>
        <Field.Label>Логин</Field.Label>
        <Input value={form.login} onChange={set("login")} placeholder="maria.b" autoComplete="username" />
        <Field.HelperText>Латиница, цифры, точка, дефис или @</Field.HelperText>
      </Field.Root>
      <Field.Root required>
        <Field.Label>Пароль</Field.Label>
        <Input type="password" value={form.password} onChange={set("password")} autoComplete="new-password" />
        <Field.HelperText>Не короче 6 символов</Field.HelperText>
      </Field.Root>
      <Button type="submit" colorPalette="teal" loading={busy}
              disabled={!form.name.trim() || form.login.trim().length < 3 || form.password.length < 6}>
        Зарегистрироваться
      </Button>
    </Stack>
  );
}
