import { Button, HStack, IconButton, Input, Stack, Text } from "@chakra-ui/react";
import { LuPlus, LuX } from "react-icons/lu";

export interface LocationRow {
  name: string;
  open: string;
  close: string;
}

export const MAX_LOCATIONS = 20;
export const blankLocation = (): LocationRow => ({ name: "", open: "10:00", close: "23:00" });

/**
 * Несколько точек-складов одной формой (ТЗ 16.17): строка на точку, «+ Ещё точка», крестик — убрать.
 * Сервер создаёт их все или ни одной, названия не повторяются.
 */
export function LocationRows({ rows, onChange, withHours, placeholders = ["Центр", "Вокзал", "Набережная"] }: {
  rows: LocationRow[];
  onChange: (rows: LocationRow[]) => void;
  /** Часы работы у каждой точки (в «Админке»); при создании предприятия — только названия */
  withHours?: boolean;
  placeholders?: string[];
}) {
  const set = (i: number, patch: Partial<LocationRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const names = rows.map((r) => r.name.trim().toLowerCase()).filter(Boolean);
  const dup = (i: number) => {
    const n = rows[i].name.trim().toLowerCase();
    return !!n && names.indexOf(n) !== names.lastIndexOf(n);
  };
  return (
    <Stack gap="2">
      {rows.map((r, i) => (
        <HStack key={i} gap="2" align="start">
          <Text textStyle="sm" color="fg.muted" w="5" pt="2" flexShrink={0} textAlign="end">{i + 1}.</Text>
          <Input flex="1" minW="0" value={r.name} onChange={(e) => set(i, { name: e.target.value })}
                 placeholder={placeholders[i] ?? `Точка ${i + 1}`} aria-label={`Точка ${i + 1}`}
                 aria-invalid={dup(i) || undefined} />
          {withHours && (
            <>
              <Input type="time" w="28" flexShrink={0} value={r.open} onChange={(e) => set(i, { open: e.target.value })} aria-label="Открытие" />
              <Input type="time" w="28" flexShrink={0} value={r.close} onChange={(e) => set(i, { close: e.target.value })} aria-label="Закрытие" />
            </>
          )}
          <IconButton aria-label="Убрать точку" variant="ghost" flexShrink={0} disabled={rows.length === 1}
                      onClick={() => onChange(rows.filter((_, j) => j !== i))}><LuX /></IconButton>
        </HStack>
      ))}
      {rows.some((_, i) => dup(i)) && <Text textStyle="xs" color="red.fg">Названия точек не должны повторяться</Text>}
      <Button size="sm" variant="outline" alignSelf="start" disabled={rows.length >= MAX_LOCATIONS}
              onClick={() => onChange([...rows, blankLocation()])}><LuPlus /> Ещё точка</Button>
    </Stack>
  );
}

/** Заполненные строки и есть ли повтор названий — для кнопки «Создать». */
export function rowsState(rows: LocationRow[]) {
  const filled = rows.filter((r) => r.name.trim());
  const names = filled.map((r) => r.name.trim().toLowerCase());
  return { filled, duplicate: new Set(names).size !== names.length };
}
