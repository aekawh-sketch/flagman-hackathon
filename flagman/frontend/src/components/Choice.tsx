import { useMemo } from "react";
import { createListCollection, Select, Text } from "@chakra-ui/react";
import type { SearchOption } from "./SearchSelect";

export interface ChoiceOption extends SearchOption {
  disabled?: boolean;
}

/** Пустое значение («Все точки») — тоже пункт списка; у Select пустая строка не выбирается, кодируем её. */
const EMPTY = "\u0000";
const enc = (v: string) => (v === "" ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? "" : v);

type RootProps = Omit<Select.RootProps<ChoiceOption>, "collection" | "value" | "onValueChange" | "onChange" | "children" | "size" | "placeholder">;

/**
 * Выбор из короткого списка — та же табличка, что у поиска по продукту ({@link SearchSelect}): пункты крупными
 * строками, подпись справа, группы заголовками. Список всплывает поверх прокрутки — в таблице и в диалоге
 * не обрезается. Длинный список, где нужен поиск, — {@link SearchSelect}.
 */
export function Choice({ options, value, onChange, placeholder = "Выберите…", size = "md", label, ...root }: RootProps & {
  options: ChoiceOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "xs" | "sm" | "md";
  /** Подпись для экранного диктора, если рядом нет видимой */
  label?: string;
}) {
  const collection = useMemo(() => createListCollection({
    items: options.map((o) => ({ ...o, value: enc(o.value) })),
    itemToValue: (o) => o.value,
    itemToString: (o) => o.label,
    isItemDisabled: (o) => !!o.disabled,
    groupBy: (o) => o.group ?? "",
  }), [options]);
  return (
    <Select.Root collection={collection} size={size} value={[enc(value)]}
                 onValueChange={(d) => { const v = d.value[0]; if (v !== undefined) onChange(dec(v)); }}
                 positioning={{ strategy: "fixed", placement: "bottom-start", gutter: 4, sameWidth: false }}
                 {...root}>
      <Select.HiddenSelect />
      <Select.Control>
        <Select.Trigger aria-label={label} cursor="pointer">
          <Select.ValueText placeholder={placeholder} />
        </Select.Trigger>
        <Select.IndicatorGroup><Select.Indicator /></Select.IndicatorGroup>
      </Select.Control>
      {/* Без Portal: внутри диалога список остаётся в нём (фокус), «fixed» выводит его поверх прокрутки */}
      <Select.Positioner>
        <Select.Content minW="var(--reference-width)" maxW="min(28rem, calc(100vw - 2rem))" maxH={{ base: "55vh", md: "72" }}
                        overflowY="auto" shadow="lg" rounded="md" py="1">
          {collection.group().map(([group, items]) => (
            <Select.ItemGroup key={group || "—"}>
              {group && (
                <Select.ItemGroupLabel px="3" pt="2" pb="1" textStyle="xs" fontWeight="semibold" color="fg.subtle"
                                       textTransform="uppercase">{group}</Select.ItemGroupLabel>
              )}
              {items.map((o) => (
                <Select.Item key={o.value} item={o} px="3" py={{ base: "2.5", md: "2" }} gap="3" justifyContent="space-between"
                             cursor="pointer" _checked={{ bg: "brand.subtle", fontWeight: "semibold" }}>
                  <Select.ItemText textStyle="sm">{o.label}</Select.ItemText>
                  {o.hint && <Text textStyle="xs" color="fg.muted" fontWeight="normal" flexShrink={0}>{o.hint}</Text>}
                </Select.Item>
              ))}
            </Select.ItemGroup>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select.Root>
  );
}
