import { useCallback, useState } from "react";

// Светлая и тёмная тема (п. 62). Класс .dark на <html> — Chakra переключает семантические цвета сама.
// Начальная тема ставится скриптом в index.html до загрузки React, чтобы не было мигания.

export type Mode = "light" | "dark";

export const currentMode = (): Mode => (document.documentElement.classList.contains("dark") ? "dark" : "light");

export function applyMode(mode: Mode) {
  const el = document.documentElement;
  el.classList.toggle("dark", mode === "dark");
  el.style.colorScheme = mode;
  try {
    localStorage.setItem("theme", mode);
  } catch {
    /* приватный режим — тема просто не запомнится */
  }
}

export function useColorMode() {
  const [mode, setMode] = useState<Mode>(currentMode);
  const toggle = useCallback(() => {
    const next: Mode = currentMode() === "dark" ? "light" : "dark";
    applyMode(next);
    setMode(next);
  }, []);
  return { mode, toggle };
}
