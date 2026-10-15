import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Box, HStack, Input, Switch, Table, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { api } from "../api";
import { useServerNow, useSession } from "../session";
import { hoursBetween, money, qty, SOURCE } from "../format";
import type { BatchDto, ProductStock } from "../types";
import { Countdown, Empty, LifeBar, Loading, PageHeader, StatusBadge } from "../components/ui";
import { Choice } from "../components/Choice";

const SOURCE_LABEL: Record<string, string> = {
  DELIVERY: "поставка", PRODUCTION: "заготовка", OPENING: "вскрыта", SURPLUS: "излишек",
};

export function StockPage() {
  const { loc } = useSession();
  const stock = useQuery({ queryKey: ["stock", loc], queryFn: () => api.stock(loc) });
  const batches = useQuery({ queryKey: ["batches", loc], queryFn: () => api.batches(loc) });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [problems, setProblems] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());

  const categories = useMemo(() => [...new Set((stock.data ?? []).map((p) => p.category).filter(Boolean))] as string[],
    [stock.data]);
  const byProduct = useMemo(() => {
    const m = new Map<string, BatchDto[]>();
    (batches.data ?? []).forEach((b) => m.set(b.productId, [...(m.get(b.productId) ?? []), b]));
    return m;
  }, [batches.data]);
  const rows = (stock.data ?? [])
    .filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()))
    .filter((p) => !category || p.category === category)
    .filter((p) => !problems || p.worstStatus === "SOON" || p.worstStatus === "CRITICAL" || p.worstStatus === "EXPIRED"
      || p.blocked > 0 || (p.daysOfCover !== null && p.daysOfCover < 0.5))
    .sort((a, b) => (a.nearestExpiry ?? "9").localeCompare(b.nearestExpiry ?? "9"));
  const toggle = (id: string) => setOpenRows((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <>
      <PageHeader title="Склад" subtitle="Общие остатки и партии. Строку можно раскрыть — там партии в порядке FEFO." />
      <HStack mb="4" gap="3" wrap="wrap">
        <Input placeholder="Поиск продукта" maxW="xs" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Choice maxW="xs" label="Категория" value={category} onChange={setCategory}
                options={[{ value: "", label: "Все категории" }, ...categories.map((c) => ({ value: c, label: c }))]} />
        <Switch.Root checked={problems} onCheckedChange={(e) => setProblems(e.checked)} colorPalette="orange">
          <Switch.HiddenInput />
          <Switch.Control><Switch.Thumb /></Switch.Control>
          <Switch.Label>Только проблемные</Switch.Label>
        </Switch.Root>
      </HStack>
      {stock.isLoading ? <Loading rows={8} /> : rows.length === 0 ? <Empty title="Ничего не найдено" /> : (
        <Table.ScrollArea borderWidth="1px" rounded="md" bg="bg.panel">
          <Table.Root size="sm" interactive>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader w="8" />
                <Table.ColumnHeader>Продукт</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Доступно</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md" textAlign="end" whiteSpace="nowrap">Скоро / критично</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="xl" textAlign="end" whiteSpace="nowrap">Ждёт списания</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md" textAlign="end" whiteSpace="nowrap">Хватит на</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="xl" textAlign="end">Стоимость</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md">Статус</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((p) => (
                <Fragment key={p.productId}>
                  <ProductRow p={p} open={openRows.has(p.productId)} onToggle={() => toggle(p.productId)} />
                  {openRows.has(p.productId) && (
                    <Table.Row bg="bg.subtle">
                      <Table.Cell colSpan={8} p="0">
                        <BatchTable batches={byProduct.get(p.productId) ?? []} />
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Fragment>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
    </>
  );
}

function ProductRow({ p, open, onToggle }: { p: ProductStock; open: boolean; onToggle: () => void }) {
  const cover = p.daysOfCover === null ? null
    : p.daysOfCover >= 10 ? "10+\u00A0дн." : `${p.daysOfCover.toFixed(1).replace(".", ",")}\u00A0дн.`;
  return (
    <Table.Row cursor="pointer" onClick={onToggle}>
      <Table.Cell color="fg.muted">{open ? <LuChevronDown /> : <LuChevronRight />}</Table.Cell>
      <Table.Cell>
        <HStack gap="2" wrap="wrap" rowGap="0.5">
          <Text fontWeight="medium">{p.name}</Text>
          {p.kind === "SEMI" && <Badge size="sm" colorPalette="purple">заготовка</Badge>}
          {p.needsReview && <Badge size="sm" colorPalette="yellow">проверить</Badge>}
        </HStack>
        <Text textStyle="xs" color="fg.muted">{p.category} · партий: {p.batches}</Text>
        {/* На телефоне скрытые колонки — строкой под названием. */}
        {(p.worstStatus || cover) && (
          <HStack hideFrom="md" gap="2" mt="1" wrap="wrap" textStyle="xs" color="fg.muted">
            <StatusBadge status={p.worstStatus} />
            {cover && <Text>хватит на {cover}</Text>}
          </HStack>
        )}
      </Table.Cell>
      <Table.Cell textAlign="end" fontWeight="semibold" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
        {p.availableText}
        {p.held > 0 && <Text textStyle="xs" color="orange.fg">под заявкой {qty(p.held, p.unit)}</Text>}
        {p.blocked > 0 && <Text textStyle="xs" color="fg.muted">заблок. {qty(p.blocked, p.unit)}</Text>}
      </Table.Cell>
      <Table.Cell hideBelow="md" textAlign="end" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
        {p.soon || p.critical ? (
          <>
            <Text as="span" color="yellow.fg">{qty(p.soon, p.unit)}</Text> / <Text as="span" color="orange.fg">{qty(p.critical, p.unit)}</Text>
          </>
        ) : <Text color="fg.subtle">—</Text>}
      </Table.Cell>
      <Table.Cell hideBelow="xl" textAlign="end" color={p.expired ? "red.fg" : "fg.subtle"}>{p.expired ? qty(p.expired, p.unit) : "—"}</Table.Cell>
      <Table.Cell hideBelow="md" textAlign="end" whiteSpace="nowrap" color={p.daysOfCover !== null && p.daysOfCover < 0.5 ? "red.fg" : undefined}>
        {cover ?? "—"}
      </Table.Cell>
      <Table.Cell hideBelow="xl" textAlign="end" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">{money(p.valueKop)}</Table.Cell>
      <Table.Cell hideBelow="md"><StatusBadge status={p.worstStatus} /></Table.Cell>
    </Table.Row>
  );
}

export function BatchTable({ batches }: { batches: BatchDto[] }) {
  const { loc } = useSession();
  const navigate = useNavigate();
  const now = useServerNow();
  if (!batches.length) return <Text p="3" color="fg.muted" textStyle="sm">Нет живых партий</Text>;
  return (
    <Table.Root size="sm" variant="line">
      <Table.Header>
        <Table.Row bg="transparent">
          <Table.ColumnHeader>Партия</Table.ColumnHeader>
          <Table.ColumnHeader hideBelow="md">Откуда</Table.ColumnHeader>
          <Table.ColumnHeader textAlign="end">Остаток</Table.ColumnHeader>
          <Table.ColumnHeader hideBelow="md">Годна до</Table.ColumnHeader>
          <Table.ColumnHeader>Осталось</Table.ColumnHeader>
          <Table.ColumnHeader hideBelow="lg">Статус</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {batches.map((b, i) => {
          const h = hoursBetween(now, b.expiresAt);
          return (
            <Table.Row key={b.id} cursor="pointer" onClick={() => navigate(`/${loc}/batches/${b.id}`)} bg="transparent">
              <Table.Cell>
                <HStack gap="2" wrap="wrap" rowGap="0.5">
                  <Text fontFamily="mono" fontWeight="semibold">{b.label}</Text>
                  {i === 0 && !b.blocked && <Badge size="sm" colorPalette="teal" variant="solid">брать первой</Badge>}
                  {b.opened && <Badge size="sm" colorPalette="purple">вскрыта</Badge>}
                </HStack>
              </Table.Cell>
              <Table.Cell hideBelow="md" textStyle="sm" color="fg.muted">
                {SOURCE_LABEL[b.source]}{b.deliveryNumber ? ` ${b.deliveryNumber}` : ""}
              </Table.Cell>
              <Table.Cell textAlign="end" fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
                {b.qtyText}<Text as="span" hideBelow="md" color="fg.subtle" textStyle="xs"> / {qty(b.qtyInitial, b.unit)}</Text>
              </Table.Cell>
              <Table.Cell hideBelow="md" textStyle="sm" whiteSpace="nowrap">{new Date(b.expiresAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</Table.Cell>
              <Table.Cell minW={{ base: "24", md: "36" }}>
                <Countdown hours={h} status={b.status} />
                <Box mt="1"><LifeBar share={b.lifeLeftShare} status={b.status} /></Box>
              </Table.Cell>
              <Table.Cell hideBelow="lg"><StatusBadge status={b.status} blocked={b.blocked} /></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table.Root>
  );
}

export { SOURCE };
