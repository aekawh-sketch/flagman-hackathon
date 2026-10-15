import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { AppConfig, ClockState, Me, Role } from "./types";

interface Session {
  me: Me | null | undefined;
  config: AppConfig | undefined;
  loc: string;
  setLoc: (loc: string) => void;
  can: (...roles: Role[]) => boolean;
  refetchMe: () => void;
  /** Перейти в другое предприятие, где человек работает (ТЗ 16.4): всё перечитывается с нуля. */
  switchTenant: (tenantId: number) => Promise<Me>;
  /** Принять новый «кто я» после входа, создания предприятия или приглашения. */
  applyMe: (me: Me) => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me().catch(() => null), staleTime: 60_000 });
  // Точки — текущего предприятия; до входа — демо-предприятия или предприятия точки из ?loc=.
  const config = useQuery({
    queryKey: ["config", me.data?.tenantId ?? 0],
    queryFn: () => api.config(new URLSearchParams(window.location.search).get("loc") ?? undefined),
    enabled: !me.isLoading,
    refetchInterval: (q) => q.state.data?.seedStatus?.startsWith("seeding") ? 1500 : false,
  });
  // Точка из адреса страницы важнее сохранённой: ссылка /kan/dashboard открывает «Ясноречье».
  const [loc, setLocState] = useState<string>(() =>
    window.location.pathname.split("/")[1] || localStorage.getItem("loc") || "");
  const locations = config.data?.locations ?? [];
  const effectiveLoc = loc && locations.some((l) => l.id === loc) ? loc
    : me.data?.locationId ?? locations[0]?.id ?? "";
  // Часы сервера сразу из конфигурации, не дожидаясь первого тика SSE.
  const updateClock = useContext(ClockCtx)?.update;
  const clock = config.data?.clock;
  useEffect(() => {
    if (clock && updateClock) {
      updateClock({ now: Date.parse(clock.now), receivedAt: Date.now(),
        state: { mode: clock.mode, speed: clock.speed, paused: clock.paused } });
    }
  }, [clock, updateClock]);

  const value = useMemo<Session>(() => ({
    me: me.data,
    config: config.data,
    loc: effectiveLoc,
    setLoc: (l: string) => {
      localStorage.setItem("loc", l);
      setLocState(l);
    },
    can: (...roles: Role[]) => !!me.data && roles.includes(me.data.role as Role),
    refetchMe: () => me.refetch(),
    applyMe: (m: Me) => {
      qc.setQueryData(["me"], m);
      // Данные прошлого предприятия не должны мелькнуть на экране нового.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
    switchTenant: async (tenantId: number) => {
      const m = await api.switchTenant(tenantId);
      localStorage.removeItem("loc");
      setLocState("");
      qc.setQueryData(["me"], m);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      return m;
    },
  }), [me.data, config.data, effectiveLoc, me, qc]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("SessionProvider missing");
  return s;
}

// ─── Часы сервера ─────────────────────────────────────────────────────────
// Время — только серверное (ТЗ 6.12): в демо оно идёт с ускорением, поэтому таймеры сроков считаются
// от последнего тика сервера с учётом скорости, а не от часов браузера.

interface ClockSnap {
  now: number;
  receivedAt: number;
  state: ClockState;
}

const ClockCtx = createContext<{ snap: ClockSnap | null; update: (s: ClockSnap) => void } | null>(null);

export function ClockProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<ClockSnap | null>(null);
  const value = useMemo(() => ({ snap, update: setSnap }), [snap]);
  return <ClockCtx.Provider value={value}>{children}</ClockCtx.Provider>;
}

export function useClockUpdater() {
  return useContext(ClockCtx)!.update;
}

export function useClockState() {
  return useContext(ClockCtx)?.snap?.state ?? null;
}

/** Текущее серверное время, обновляется раз в секунду. */
export function useServerNow(): number {
  const snap = useContext(ClockCtx)?.snap ?? null;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!snap) return Date.now();
  const elapsed = Date.now() - snap.receivedAt;
  return snap.state.mode === "SIM" && !snap.state.paused ? snap.now + elapsed * snap.state.speed
    : snap.state.mode === "SIM" ? snap.now : snap.now + elapsed;
}

// ─── Реальное время: SSE (ТЗ 5.13) ────────────────────────────────────────

export function useLiveEvents(loc: string, onAlert: (a: {
  title: string; body: string; severity: string; type?: string; objectType?: string; objectId?: string;
}) => void) {
  const qc = useQueryClient();
  const updateClock = useClockUpdater();
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;
  useEffect(() => {
    if (!loc) return;
    const es = new EventSource(`/api/${loc}/events`);
    const invalidateLoc = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
    es.addEventListener("stock", invalidateLoc);
    // Чек на кухню напечатан или не напечатался — лента чеков у повара обновляется сама
    es.addEventListener("kitchen", () => qc.invalidateQueries({ queryKey: ["kitchen-tickets", loc] }));
    es.addEventListener("reset", () => qc.invalidateQueries());
    es.addEventListener("alert", (e) => {
      qc.invalidateQueries({ queryKey: ["alerts", loc] });
      qc.invalidateQueries({ queryKey: ["dashboard", loc] });
      const data = JSON.parse((e as MessageEvent).data);
      if (data.title) onAlertRef.current(data);
    });
    es.addEventListener("clock", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      updateClock({ now: Date.parse(d.now), receivedAt: Date.now(),
        state: { mode: d.mode, speed: d.speed, paused: d.paused } });
    });
    // При переподключении — свежий снимок данных.
    es.addEventListener("hello", invalidateLoc);
    return () => es.close();
  }, [loc, qc, updateClock]);
}
