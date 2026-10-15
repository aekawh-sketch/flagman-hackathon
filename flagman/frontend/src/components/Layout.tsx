import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  Avatar, Badge, Box, Button, CloseButton, Drawer, Flex, HStack, IconButton, Menu, Popover, Portal, Stack,
  Text, useBreakpointValue, VStack,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useColorMode } from "../colorMode";
import {
  LuBell, LuBookOpen, LuCheck, LuBoxes, LuChartColumn, LuChefHat, LuClipboardList, LuFlame, LuGauge, LuLock,
  LuLogOut, LuMenu, LuMoon, LuPackageCheck, LuReceipt, LuRoute, LuScale, LuScanQrCode, LuScrollText, LuSettings, LuShieldAlert,
  LuShieldCheck, LuShoppingCart, LuSun, LuTrash2, LuUtensils, LuWandSparkles,
} from "react-icons/lu";
import { api } from "../api";
import { useClockState, useLiveEvents, useServerNow, useSession } from "../session";
import { dateTime, ROLE, time } from "../format";
import type { Role } from "../types";
import { toaster } from "./Toaster";
import { useEnterTenant } from "./Tenants";
import { APPROVAL_ALERTS, alertPath } from "../alerts";
import { Empty } from "./ui";
import { HOME } from "../home";
import { Choice } from "./Choice";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  roles: Role[];
  demoOnly?: boolean;
}

const ALL: Role[] = ["COOK", "CASHIER", "STOREKEEPER", "MANAGER", "ADMIN"];
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Работа",
    items: [
      { to: "dashboard", label: "Дашборд", icon: <LuGauge />, roles: ["MANAGER", "ADMIN"] },
      // Касса — не здесь, а в панели ресторана: кассиру — куда идти и с каким логином.
      { to: "pos", label: "Касса", icon: <LuShoppingCart />, roles: ["CASHIER"] },
      { to: "kitchen", label: "Кухня", icon: <LuChefHat />, roles: ["COOK", "MANAGER"] },
      { to: "acceptance", label: "Приёмка", icon: <LuPackageCheck />, roles: ["STOREKEEPER", "MANAGER", "ADMIN"] },
      { to: "stock", label: "Склад", icon: <LuBoxes />, roles: ["COOK", "STOREKEEPER", "MANAGER", "ADMIN"] },
    ],
  },
  {
    group: "Меню",
    items: [
      { to: "menu", label: "Меню и стоп-лист", icon: <LuUtensils />, roles: ALL },
      // Горячие предложения — для тех, кто продаёт и готовит; кладовщику они не нужны.
      { to: "hot", label: "Горячие предложения", icon: <LuFlame />, roles: ["COOK", "CASHIER", "MANAGER", "ADMIN"] },
      { to: "purchases", label: "Закупки", icon: <LuReceipt />, roles: ["STOREKEEPER", "MANAGER", "ADMIN"] },
      { to: "recipes", label: "Техкарты", icon: <LuBookOpen />, roles: ["MANAGER", "ADMIN"] },
    ],
  },
  {
    group: "Контроль",
    items: [
      { to: "writeoffs", label: "Заявки на списание", icon: <LuTrash2 />, roles: ["COOK", "STOREKEEPER", "MANAGER", "ADMIN"] },
      { to: "inventory", label: "Инвентаризация", icon: <LuScale />, roles: ["STOREKEEPER", "MANAGER", "ADMIN"] },
      { to: "analytics", label: "Аналитика", icon: <LuChartColumn />, roles: ["MANAGER", "ADMIN"] },
      { to: "trace", label: "Прослеживаемость", icon: <LuRoute />, roles: ["MANAGER", "ADMIN"] },
      { to: "anomalies", label: "Подозрительное", icon: <LuShieldAlert />, roles: ["MANAGER", "ADMIN"] },
      { to: "ledger", label: "Журнал", icon: <LuScrollText />, roles: ["MANAGER", "ADMIN"] },
    ],
  },
  {
    group: "Система",
    items: [
      { to: "admin", label: "Админка", icon: <LuSettings />, roles: ["ADMIN"] },
      { to: "demo", label: "Демо-панель", icon: <LuWandSparkles />, roles: ["ADMIN"], demoOnly: true },
    ],
  },
];

/** Раздел из меню, недоступный роли, не открывается и по прямой ссылке. */
function Guarded() {
  const { me, loc } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const section = pathname.split("/")[2];
  const item = NAV.flatMap((g) => g.items).find((i) => i.to === section);
  if (item && me && !item.roles.includes(me.role as Role)) {
    return (
      <Empty icon={<LuLock />} title={`Раздел «${item.label}» недоступен`}
             description={`У роли «${ROLE[me.role as Role]}» нет доступа. Ваш стартовый экран — «${
               NAV.flatMap((g) => g.items).find((i) => i.to === HOME[me.role as Role])?.label ?? "главная"}».`}
             action={<Button size="sm" onClick={() => navigate(`/${loc}/${HOME[me.role as Role]}`)}>Перейти</Button>} />
    );
  }
  return <Outlet />;
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { me, loc, config } = useSession();
  return (
    <Stack gap="5">
      {NAV.map((g) => {
        const items = g.items.filter((i) => me && i.roles.includes(me.role as Role) && (!i.demoOnly || config?.demoMode));
        if (!items.length) return null;
        return (
          <Box key={g.group}>
            <Text px="3" mb="1.5" textStyle="xs" fontWeight="semibold" color="fg.subtle" textTransform="uppercase"
                  letterSpacing="0.06em">{g.group}</Text>
            <Stack gap="0.5">
              {items.map((i) => (
                <NavLink key={i.to} to={`/${loc}/${i.to}`} onClick={onNavigate}>
                  {({ isActive }) => (
                    <HStack px="3" py="2" rounded="md" gap="2.5" textStyle="sm"
                            bg={isActive ? "brand.muted" : undefined} color={isActive ? "brand.fg" : "fg.muted"}
                            fontWeight={isActive ? "semibold" : "medium"}
                            _hover={{ bg: isActive ? "brand.muted" : "bg.muted", color: "fg" }}>
                      <Box fontSize="md">{i.icon}</Box>
                      <Text>{i.label}</Text>
                    </HStack>
                  )}
                </NavLink>
              ))}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

function ServerClock() {
  const now = useServerNow();
  const state = useClockState();
  return (
    <HStack gap="1.5" title={dateTime(now)}>
      <Text fontVariantNumeric="tabular-nums" fontWeight="semibold" textStyle="sm">{time(now)}</Text>
      {state?.mode === "SIM" && (
        <Badge colorPalette={state.paused ? "gray" : "purple"} variant="subtle" size="sm" hideBelow="sm">
          {state.paused ? "пауза" : `×${state.speed}`}
        </Badge>
      )}
    </HStack>
  );
}

function Bell() {
  const { loc, can } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [popover, setPopover] = useState(false);
  const decides = can("MANAGER", "ADMIN");
  const alerts = useQuery({ queryKey: ["alerts", loc, "open"], queryFn: () => api.alerts(loc, true), enabled: !!loc });
  // Запросы на одобрение видит только тот, кто их решает.
  const open = (alerts.data ?? []).filter((a) => decides || !APPROVAL_ALERTS.includes(a.type));
  const ack = async (id: number) => {
    await api.ack(loc, id);
    qc.invalidateQueries({ queryKey: ["alerts", loc] });
  };
  /** Открыть то, о чём сигнал; обычный сигнал этим и отмечается «увидел», запрос — висит до решения. */
  const openAlert = (a: (typeof open)[number]) => {
    const to = alertPath(a);
    if (!to) return;
    if (!APPROVAL_ALERTS.includes(a.type)) ack(a.id).catch(() => undefined);
    setPopover(false);
    navigate(`/${loc}/${to}`);
  };
  return (
    <Popover.Root positioning={{ placement: "bottom-end" }} open={popover} onOpenChange={(e) => setPopover(e.open)}>
      <Popover.Trigger asChild>
        <Box position="relative">
          <IconButton aria-label="Сигналы" variant="ghost" size="sm"><LuBell /></IconButton>
          {open.length > 0 && (
            <Badge position="absolute" top="-1" right="-1" colorPalette="red" variant="solid" size="xs" rounded="full">
              {open.length > 99 ? "99+" : open.length}
            </Badge>
          )}
        </Box>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content width={{ base: "90vw", md: "md" }}>
            <Popover.Header>
              <Flex justify="space-between" align="center">
                <Text fontWeight="semibold">Сигналы</Text>
                {open.length > 0 && (
                  <Button size="xs" variant="ghost" onClick={async () => {
                    await api.ackAll(loc);
                    toaster.remove();              // и всплывающие уведомления — тоже прочь
                    qc.invalidateQueries({ queryKey: ["alerts", loc] });
                  }}>Отметить все</Button>
                )}
              </Flex>
            </Popover.Header>
            <Popover.Body maxH="60vh" overflowY="auto" pt="0">
              {open.length === 0 && <Text color="fg.muted" textStyle="sm" py="4">Новых сигналов нет</Text>}
              <Stack gap="2">
                {open.map((a) => (
                  <Flex key={a.id} gap="3" p="2.5" rounded="md" borderWidth="1px"
                        borderColor={a.severity === "CRITICAL" ? "red.muted" : "border"}>
                    <Box w="1" rounded="full" flexShrink={0}
                         bg={a.severity === "CRITICAL" ? "red.solid" : a.severity === "WARN" ? "orange.solid" : "blue.solid"} />
                    <Box flex="1" minW="0" cursor={alertPath(a) ? "pointer" : undefined} onClick={() => openAlert(a)}
                         _hover={alertPath(a) ? { "& .t": { color: "brand.fg", textDecoration: "underline" } } : undefined}>
                      <Text className="t" textStyle="sm" fontWeight="medium">{a.title}</Text>
                      {a.body && <Text textStyle="xs" color="fg.muted" lineClamp={3}>{a.body}</Text>}
                      <Text textStyle="xs" color="fg.subtle" mt="1">{dateTime(a.createdAt)}{alertPath(a) ? " · открыть →" : ""}</Text>
                    </Box>
                    {decides && APPROVAL_ALERTS.includes(a.type) ? (
                      <Button size="xs" colorPalette="teal" onClick={() => openAlert(a)}>Рассмотреть</Button>
                    ) : (
                      <Button size="xs" variant="outline" onClick={() => ack(a.id)}>Увидел</Button>
                    )}
                  </Flex>
                ))}
              </Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

/**
 * Сканер QR этикетки — только в Android-приложении (android/): камеру включает само приложение — страница по http
 * камеру не получит. Приложение присылает текст QR событием «flagman:qr»; этикетка — ссылка …/{точка}/batches/{id}
 * с адресом склада, где её печатали. Номер партии — свой у каждой базы: этикетка с другого склада (другой адрес)
 * открыла бы «не найдена» или, хуже, чужую партию с тем же номером — поэтому сначала говорим об этом.
 */
type AndroidBridge = { scanQr?: () => void };
const androidBridge = () => (window as unknown as { FlagmanAndroid?: AndroidBridge }).FlagmanAndroid;
const canScanQr = () => typeof androidBridge()?.scanQr === "function";

function QrScanButton() {
  const navigate = useNavigate();
  useEffect(() => {
    const onQr = (e: Event) => {
      const text = String((e as CustomEvent<string>).detail ?? "").trim();
      let url: URL | null = null;
      try {
        url = new URL(text, window.location.origin);
      } catch {
        url = null;
      }
      const batch = url?.pathname.match(/^\/([\w-]+)\/batches\/(\d+)\/?$/);
      if (!url || !batch) {
        toaster.create({ type: "error", title: "Это не этикетка партии", description: text.slice(0, 120), closable: true });
        return;
      }
      const path = `/${batch[1]}/batches/${batch[2]}`;
      if (url.origin === window.location.origin) {
        navigate(path);
        return;
      }
      toaster.create({
        type: "warning",
        title: "Этикетка с другого склада",
        description: `Её печатали на ${url.host}, а это склад ${window.location.host} — у каждого склада свои партии и номера.`,
        closable: true,
        duration: 10_000,
        action: { label: "Всё равно открыть", onClick: () => navigate(path) },
      });
    };
    window.addEventListener("flagman:qr", onQr);
    return () => window.removeEventListener("flagman:qr", onQr);
  }, [navigate]);
  return (
    <IconButton aria-label="Сканировать QR этикетки" title="Сканировать QR этикетки" variant="ghost" size="sm"
                onClick={() => androidBridge()?.scanQr?.()}>
      <LuScanQrCode />
    </IconButton>
  );
}

function ThemeToggle() {
  const { mode, toggle } = useColorMode();
  return (
    <IconButton aria-label="Тема" variant="ghost" size="sm" onClick={toggle}>
      {mode === "dark" ? <LuSun /> : <LuMoon />}
    </IconButton>
  );
}

/**
 * Заявку на своё предприятие одобрили, пока человек работает в другом: уведомление с кнопкой «Перейти» —
 * не выдёргиваем его посреди заказа или приёмки. Пока заявка ждёт — переспрашиваем раз в 15 секунд.
 */
function useApprovedTenant() {
  const { me, refetchMe } = useSession();
  const enter = useEnterTenant();
  const requests = useQuery({
    queryKey: ["my-tenant-requests"], queryFn: api.myTenantRequests, enabled: me?.kind === "USER",
    refetchInterval: (q) => q.state.data?.some((r) => r.status === "PENDING") ? 15_000 : false,
  });
  const approved = requests.data?.find((r) => r.status === "APPROVED" && r.tenantId
    && !me?.tenants.some((t) => t.tenantId === r.tenantId));
  const shown = useRef(new Set<number>());
  useEffect(() => {
    if (!approved?.tenantId || shown.current.has(approved.id)) return;
    shown.current.add(approved.id);
    const tenantId = approved.tenantId;
    refetchMe();    // новое предприятие — сразу в переключателе в меню профиля
    toaster.create({
      type: "success", title: `Заявка одобрена: «${approved.name}»`, duration: 60_000,
      description: "Вы админ нового предприятия. Начните с меню и сотрудников",
      action: { label: "Перейти", onClick: () => { enter(tenantId).catch(() => undefined); } },
    });
  }, [approved, enter, refetchMe]);
}

export function Layout() {
  const { me, loc, setLoc, config, refetchMe, switchTenant } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState(false);
  const scanQr = canScanQr();
  const decides = !!me && ["MANAGER", "ADMIN"].includes(me.role);
  const toTenant = async (tenantId: number) => {
    try {
      const m = await switchTenant(tenantId);
      toaster.create({ type: "success", title: `Предприятие «${m.tenantName}»`, description: ROLE[m.role as Role] });
      navigate("/");
    } catch (e) {
      toaster.create({ type: "error", title: e instanceof Error ? e.message : "Не удалось переключиться" });
    }
  };
  useApprovedTenant();
  // На телефоне в шапке тесно: «Точка «Центр»» → «Центр».
  const shortNames = useBreakpointValue({ base: true, sm: false });

  useLiveEvents(loc, (a) => {
    // Заявка ждёт решения: управляющему и админу — запрос с кнопкой «Рассмотреть», остальным не мешаем.
    if (a.type && APPROVAL_ALERTS.includes(a.type)) {
      const to = alertPath(a);
      if (decides) {
        toaster.create({ type: "info", title: `Запрос на одобрение: ${a.title}`, description: a.body, duration: 20000,
          action: to ? { label: "Рассмотреть", onClick: () => navigate(`/${loc}/${to}`) } : undefined });
      }
      return;
    }
    if (a.severity === "CRITICAL" || a.severity === "WARN") {
      // У уведомления — ссылка туда, о чём оно: партия, поставка, заказ, подозрительная операция.
      const to = alertPath(a);
      toaster.create({ type: a.severity === "CRITICAL" ? "error" : "warning", title: a.title, description: a.body,
        action: to ? { label: "Открыть", onClick: () => navigate(`/${loc}/${to}`) } : undefined });
      if (a.severity === "CRITICAL") {
        try {
          new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=").play()
            .catch(() => undefined);
        } catch { /* звук необязателен */ }
      }
    }
  });

  const logout = async () => {
    await api.logout();
    qc.clear();
    refetchMe();
    navigate("/login");
  };

  const locations = config?.locations ?? [];
  const sidebar = (
    <VStack align="stretch" gap="6">
      <Box px="3">
        <HStack gap="2">
          <Box w="8" h="8" rounded="lg" bg="brand.solid" color="white" display="grid" placeItems="center">
            <LuClipboardList />
          </Box>
          <Box>
            <Text fontWeight="bold" lineHeight="1.1">Склад</Text>
            <Text textStyle="xs" color="fg.muted" lineClamp={1}>{config?.restaurantName}</Text>
          </Box>
        </HStack>
      </Box>
      <Nav onNavigate={() => setDrawer(false)} />
    </VStack>
  );

  return (
    <Flex minH="100vh">
      <Box as="aside" w="64" flexShrink={0} display={{ base: "none", lg: "block" }} borderRightWidth="1px"
           bg="bg.panel" py="5" px="3" position="sticky" top="0" h="100vh" overflowY="auto">
        {sidebar}
      </Box>
      <Drawer.Root open={drawer} onOpenChange={(e) => setDrawer(e.open)} placement="start">
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content maxW="72">
              <Drawer.Body py="5" px="3">{sidebar}</Drawer.Body>
              <Drawer.CloseTrigger asChild><CloseButton size="sm" /></Drawer.CloseTrigger>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
      <Box flex="1" minW="0">
        <Flex as="header" h="14" px={{ base: "2", md: "6" }} align="center" gap={{ base: "1", sm: "3" }} borderBottomWidth="1px"
              bg="bg.panel" position="sticky" top="0" zIndex="docked">
          <IconButton aria-label="Меню" variant="ghost" size="sm" display={{ lg: "none" }}
                      onClick={() => setDrawer(true)}><LuMenu /></IconButton>
          <Choice size="sm" w="auto" minW={{ base: "32", sm: "44" }} maxW="60" flexShrink={1} disabled={!!me?.locationId} label="Точка"
                  value={loc} options={locations.map((l) => ({ value: l.id, label: shortNames ? l.name.replace(/^Точка\s+/, "") : l.name }))}
                  onChange={(v) => {
                    setLoc(v);
                    const rest = window.location.pathname.split("/").slice(2).join("/");
                    navigate(`/${v}/${rest}`);
                  }} />
          <Box flex="1" />
          {/* В приложении на телефоне место часов — у сканера: шапка узкая */}
          <Box hideBelow={scanQr ? "sm" : undefined}><ServerClock /></Box>
          {scanQr && <QrScanButton />}
          <Bell />
          <ThemeToggle />
          <Menu.Root positioning={{ placement: "bottom-end" }}>
            <Menu.Trigger asChild>
              <Button variant="ghost" size="sm" px={{ base: "1", md: "2" }} aria-label="Профиль">
                <Box textAlign="right" hideBelow="md">
                  <Text textStyle="sm" fontWeight="medium" lineHeight="1.1">{me?.name}</Text>
                  <Text textStyle="xs" color="fg.muted">{me && ROLE[me.role as Role]}</Text>
                </Box>
                {/* На телефоне вместо имени — инициалы, имя и роль — в меню. */}
                <Avatar.Root size="xs" hideFrom="md" colorPalette="teal"><Avatar.Fallback name={me?.name} /></Avatar.Root>
              </Button>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content>
                  <Box hideFrom="md" px="2" py="1.5" mb="1" borderBottomWidth="1px">
                    <Text textStyle="sm" fontWeight="medium">{me?.name}</Text>
                    <Text textStyle="xs" color="fg.muted">{me && ROLE[me.role as Role]}</Text>
                  </Box>
                  {/* Предприятия (ТЗ 16.4): у одного человека — несколько ресторанов с разными ролями */}
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel>Предприятие</Menu.ItemGroupLabel>
                    {me?.tenants.map((t) => (
                      <Menu.Item key={t.tenantId} value={`tenant-${t.tenantId}`}
                                 onClick={() => t.tenantId !== me.tenantId && toTenant(t.tenantId)}>
                        <Box flex="1" minW="0">
                          <Text lineClamp={1}>{t.tenantName}</Text>
                          <Text textStyle="xs" color="fg.muted">{ROLE[t.role]}</Text>
                        </Box>
                        {t.tenantId === me.tenantId && <LuCheck />}
                      </Menu.Item>
                    ))}
                    {/* Новые предприятия создаёт только администратор платформы — в своей консоли (ТЗ 16.14) */}
                  </Menu.ItemGroup>
                  {me?.platformAdmin && (
                    <Menu.Item value="platform" onClick={() => navigate("/platform")}><LuShieldCheck /> Админка платформы</Menu.Item>
                  )}
                  <Menu.Separator />
                  <Menu.Item value="logout" onClick={logout}><LuLogOut /> Выйти</Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </Flex>
        <Box as="main" px={{ base: "3", md: "6" }} py={{ base: "4", md: "6" }} maxW="1500px" mx="auto">
          <Guarded />
        </Box>
      </Box>
    </Flex>
  );
}
