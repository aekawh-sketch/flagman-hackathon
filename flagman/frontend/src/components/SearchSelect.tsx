import { useMemo, useRef, useState } from "react";
import { Box, chakra, Input, InputGroup, Stack, Text } from "@chakra-ui/react";
import { LuChevronDown, LuSearch } from "react-icons/lu";

export interface SearchOption {
  value: string;
  label: string;
  /** Подпись справа или под названием: «есть 2 кг», «Роллы» */
  hint?: string;
  /** Группа — заголовком над её пунктами: «Сырьё», «Заготовки» */
  group?: string;
}

/** Буква «ё» и регистр не мешают поиску: «еж» найдёт «Ёжик». */
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/**
 * Выбор из длинного списка с поиском — удобно с телефона: печатаете пару букв, ниже сразу подходящие пункты
 * крупными строками под палец. Без поиска список показывается целиком, сгруппированным.
 */
export function SearchSelect({ options, value, onChange, placeholder = "Найти…", empty = "Ничего не нашлось", size = "md" }: {
  options: SearchOption[]; value: string; onChange: (value: string) => void;
  placeholder?: string; empty?: string; size?: "sm" | "md";
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;
  const shown = useMemo(() => {
    const q = norm(query.trim());
    return (q ? options.filter((o) => norm(o.label).includes(q) || (o.hint && norm(o.hint).includes(q))) : options).slice(0, 200);
  }, [options, query]);
  const pick = (o: SearchOption) => {
    onChange(o.value);
    setQuery("");
    setOpen(false);
    input.current?.blur();
  };
  let lastGroup: string | undefined;
  return (
    <Box position="relative" w="full">
      <InputGroup w="full" startElement={<LuSearch />} endElement={<LuChevronDown />}>
        <Input ref={input} size={size} value={open ? query : selected?.label ?? ""} placeholder={selected ? selected.label : placeholder}
               onFocus={() => { setOpen(true); setQuery(""); }} onBlur={() => setTimeout(() => setOpen(false), 150)}
               onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
               onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) { e.preventDefault(); pick(shown[0]); } if (e.key === "Escape") input.current?.blur(); }}
               role="combobox" aria-expanded={open} aria-autocomplete="list" />
      </InputGroup>
      {open && (
        <Box position="absolute" top="100%" left="0" right="0" mt="1" zIndex="dropdown" bg="bg.panel" borderWidth="1px"
             rounded="md" shadow="lg" maxH={{ base: "55vh", md: "72" }} overflowY="auto" role="listbox">
          {!shown.length ? <Text p="3" textStyle="sm" color="fg.muted">{empty}</Text> : (
            <Stack gap="0" py="1">
              {shown.map((o) => {
                const head = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                return (
                  <Box key={o.value}>
                    {head && !query && (
                      <Text px="3" pt="2" pb="1" textStyle="xs" fontWeight="semibold" color="fg.subtle" textTransform="uppercase">{head}</Text>
                    )}
                    <chakra.button type="button" w="full" textAlign="start" px="3" py={{ base: "2.5", md: "2" }} display="flex"
                                   justifyContent="space-between" gap="3" role="option" aria-selected={o.value === value}
                                   bg={o.value === value ? "brand.subtle" : undefined} _hover={{ bg: "bg.muted" }}
                                   onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}>
                      <Text textStyle="sm" fontWeight={o.value === value ? "semibold" : undefined}>{o.label}</Text>
                      {o.hint && <Text textStyle="xs" color="fg.muted" flexShrink={0}>{o.hint}</Text>}
                    </chakra.button>
                  </Box>
                );
              })}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  );
}
