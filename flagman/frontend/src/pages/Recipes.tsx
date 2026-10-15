import { useMemo, useState } from "react";
import {
  Badge, Box, Button, Flex, Grid, HStack, IconButton, Input, Stack, Table, Text,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LuChevronDown, LuChevronRight, LuPencil, LuPlus, LuTrash2, LuUndo2 } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, glue, money, qty } from "../format";
import type { CatalogVariant, RecipeVersion } from "../types";
import { SearchSelect } from "../components/SearchSelect";
import { Loading, PageHeader, Section } from "../components/ui";
import { notifyError, notifyOk } from "../components/Toaster";

/** Техкарты (ТЗ 5.4, 6.9): нетто → брутто через % потерь; правят управляющий и админ, каждая правка — новая версия. */
export function RecipesPage() {
  const { can } = useSession();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const dishes = (catalog.data?.dishes ?? []).filter((d) => !search || d.name.toLowerCase().includes(search.toLowerCase()));
  const variant = useMemo(() => catalog.data?.dishes.flatMap((d) => d.variants).find((v) => v.id === selected) ?? null,
    [catalog.data, selected]);

  return (
    <>
      <PageHeader title="Техкарты" subtitle="Состав на одну порцию: нетто идёт в блюдо, брутто списывается со склада с учётом потерь при обработке" />
      {catalog.isLoading ? <Loading rows={8} /> : (
        <Grid templateColumns={{ base: "1fr", lg: "360px 1fr" }} gap="4" alignItems="start">
          <Section title="Блюда">
            <Input size="sm" mb="2" placeholder="Поиск" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Stack gap="0.5" maxH={{ base: "45vh", lg: "70vh" }} overflowY="auto">
              {dishes.map((d) => d.variants.map((v) => (
                <Box key={v.id} px="2" py="1.5" rounded="md" cursor="pointer" bg={selected === v.id ? "brand.muted" : undefined}
                     _hover={{ bg: "bg.muted" }} onClick={() => {
                       setSelected(v.id);
                       // На телефоне состав — под списком: сразу показываем его.
                       if (window.matchMedia("(max-width: 991px)").matches) {
                         setTimeout(() => document.getElementById("recipe")?.scrollIntoView({ behavior: "smooth" }), 50);
                       }
                     }}>
                  <Text textStyle="sm" fontWeight={selected === v.id ? "semibold" : undefined}>{glue(v.name)}</Text>
                  <Text textStyle="xs" color="fg.muted">{d.category} · {money(v.priceKop)}</Text>
                </Box>
              )))}
            </Stack>
          </Section>
          {variant ? <Box id="recipe" scrollMarginTop="16"><RecipeEditor key={variant.id} v={variant} editable={can("MANAGER", "ADMIN")} /></Box> : (
            <Section title="Выберите блюдо"><Text color="fg.muted">Слева — все блюда и их варианты (размеры, виды).</Text></Section>
          )}
        </Grid>
      )}
    </>
  );
}

/** Брутто = ⌈нетто / (1 − потери)⌉ — как на сервере. */
const gross = (net: number, lossBp: number) => Math.ceil((net * 10000) / (10000 - lossBp));
const UNIT: Record<string, string> = { G: "г", ML: "мл", PCS: "шт" };

interface EditLine { productId: string; net: string; loss: string }

function RecipeEditor({ v, editable }: { v: CatalogVariant; editable: boolean }) {
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const versions = useQuery({ queryKey: ["recipe-versions", v.id], queryFn: () => api.recipeVersions(v.id), enabled: !v.isSet });
  const products = catalog.data?.products ?? [];
  const productOf = (id: string) => products.find((p) => p.id === id);
  const [editing, setEditing] = useState(false);
  const toEdit = () => v.lines.map((l) => ({ productId: l.productId, net: String(l.net), loss: l.lossBp == null ? "" : String(l.lossBp / 100) }));
  const [lines, setLines] = useState<EditLine[]>(toEdit);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const cost = v.lines.reduce((s, l) => s + (productOf(l.productId)?.unitCostKop ?? 0) * l.gross, 0);

  // Черновик: брутто и себестоимость считаются на глазах, ошибки — до отправки.
  const draft = lines.map((l) => {
    const p = productOf(l.productId);
    const net = Number(l.net);
    const lossBp = l.loss === "" ? p?.lossBp ?? 0 : Math.round(Number(l.loss) * 100);
    const ok = !!p && Number.isInteger(net) && net > 0 && lossBp >= 0 && lossBp <= 9500;
    return { ...l, p, net, lossBp, ok, gross: ok ? gross(net, lossBp) : 0 };
  });
  const dup = new Set(draft.map((d) => d.productId).filter((id, i, a) => id && a.indexOf(id) !== i));
  const draftCost = draft.reduce((s, d) => s + (d.p?.unitCostKop ?? 0) * d.gross, 0);
  const valid = draft.length > 0 && draft.every((d) => d.ok) && dup.size === 0;

  const refresh = () => qc.invalidateQueries();
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveRecipe(v.id, draft.map((d) => ({ productId: d.productId, net: d.net,
        lossBp: d.loss === "" ? null : d.lossBp })), comment.trim() || "Правка техкарты");
      notifyOk(r.newVersion ? "Сохранено — создана новая версия" : "Состав не изменился — версия та же");
      setEditing(false);
      setComment("");
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="4">
      <Section title={glue(v.name)} actions={!v.isSet && (
        <HStack gap="3" wrap="wrap">
          <Text textStyle="sm" color="fg.muted">
            себестоимость ≈ {money(editing ? draftCost : cost)} · фудкост {v.priceKop ? Math.round((editing ? draftCost : cost) / v.priceKop * 100) : 0}%
          </Text>
          {editable && !editing && (
            <Button size="sm" variant="outline" onClick={() => { setLines(toEdit()); setEditing(true); }}><LuPencil /> Изменить</Button>
          )}
        </HStack>
      )}>
        {v.isSet ? (
          <Stack gap="1">
            <Text textStyle="sm" color="fg.muted" mb="1">Сет раскладывается на входящие блюда:</Text>
            {v.setItems.map((s) => <Text key={s.variantId}>{glue(`${s.name} ×${s.qty}`)}</Text>)}
          </Stack>
        ) : !editing ? (
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Продукт</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Нетто</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Потери</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end">Брутто<Box as="span" hideBelow="md"> (со склада)</Box></Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {v.lines.map((l) => (
                <Table.Row key={l.productId}>
                  <Table.Cell>{l.productName}</Table.Cell>
                  <Table.Cell textAlign="end">{qty(l.net, l.unit)}</Table.Cell>
                  <Table.Cell textAlign="end" color="fg.muted">
                    {((l.lossBp ?? productOf(l.productId)?.lossBp ?? 0) / 100).toFixed(0)}%
                  </Table.Cell>
                  <Table.Cell textAlign="end" fontWeight="semibold">{qty(l.gross, l.unit)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        ) : (
          <Stack gap="2">
            <Text textStyle="sm" color="fg.muted">
              Нетто — сколько идёт в блюдо, в граммах, миллилитрах или штуках. Потери — свой % для этой строки;
              пусто — как у продукта. Сохранение создаст новую версию; старые не меняются, заказы помнят свою.
            </Text>
            {draft.map((d, i) => (
              <Flex key={i} gap="2" align="center" wrap="wrap" p="2" borderWidth="1px" rounded="md"
                    borderColor={(d.productId && !d.ok) || dup.has(d.productId) ? "red.muted" : undefined}>
                <Box flex="2 1 200px">
                  <SearchSelect size="sm" value={d.productId} placeholder="Продукт: начните печатать…"
                                onChange={(v) => setLines(lines.map((x, j) => j === i ? { ...x, productId: v } : x))}
                                options={[...products].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "ru")
                                  : a.kind === "RAW" ? -1 : 1)).map((p) => ({ value: p.id, label: p.name,
                                  group: p.kind === "SEMI" ? "Заготовки" : "Сырьё", hint: p.kind === "SEMI" ? "заготовка" : undefined }))} />
                </Box>
                <HStack gap="1" flex="1 1 120px">
                  <Input size="sm" type="number" min={1} inputMode="numeric" value={d.net} placeholder="нетто" aria-label="Нетто"
                         onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, net: e.target.value } : x))} />
                  <Text textStyle="sm" color="fg.muted" w="6">{d.p ? UNIT[d.p.unit] : ""}</Text>
                </HStack>
                <HStack gap="1" flex="0 1 110px">
                  <Input size="sm" type="number" min={0} max={95} value={d.loss} aria-label="Потери, %"
                         placeholder={d.p ? String(d.p.lossBp / 100) : "%"}
                         onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, loss: e.target.value } : x))} />
                  <Text textStyle="sm" color="fg.muted">%</Text>
                </HStack>
                <Text textStyle="sm" fontWeight="semibold" minW="20" textAlign="end">
                  {d.ok && d.p ? `→ ${qty(d.gross, d.p.unit)}` : ""}
                </Text>
                <IconButton aria-label="Убрать строку" size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                  <LuTrash2 />
                </IconButton>
                {dup.has(d.productId) && <Text w="full" textStyle="xs" color="red.fg">Этот продукт уже есть в техкарте</Text>}
              </Flex>
            ))}
            <Button size="sm" variant="outline" alignSelf="flex-start" onClick={() => setLines([...lines, { productId: "", net: "", loss: "" }])}>
              <LuPlus /> Строка
            </Button>
            <Input size="sm" placeholder="Что поменяли и почему — останется в истории версий" value={comment}
                   onChange={(e) => setComment(e.target.value)} />
            <HStack justify="flex-end" wrap="wrap">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Отмена</Button>
              <Button size="sm" colorPalette="teal" loading={busy} disabled={!valid} onClick={save}>Сохранить как новую версию</Button>
            </HStack>
            <Text textStyle="xs" color="fg.muted">Рост граммовки больше 20 % попадёт в «Подозрительные операции».</Text>
          </Stack>
        )}
      </Section>

      {!v.isSet && (
        <Section title="Версии">
          {versions.isLoading ? <Loading rows={2} /> : (
            <Stack gap="2">
              {versions.data?.map((x) => (
                <VersionRow key={x.id} x={x} active={versions.data?.find((y) => y.status === "ACTIVE") ?? null}
                            variantId={v.id} editable={editable} onDone={refresh} />
              ))}
            </Stack>
          )}
        </Section>
      )}
    </Stack>
  );
}

/** Версия техкарты: состав, чем отличается от действующей, и «Вернуть эту версию» — новой версией. */
function VersionRow({ x, active, variantId, editable, onDone }: {
  x: RecipeVersion; active: RecipeVersion | null; variantId: string; editable: boolean; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const isActive = x.status === "ACTIVE";
  const now = new Map((active?.lines ?? []).map((l) => [l.productId, l]));
  const was = new Map(x.lines.map((l) => [l.productId, l]));
  const removed = (active?.lines ?? []).filter((l) => !was.has(l.productId));
  const restore = async () => {
    setBusy(true);
    try {
      const r = await api.restoreRecipe(variantId, x.id, comment.trim());
      notifyOk(`Техкарта возвращена к v${r.restoredFrom}`, "Создана новая версия с этим составом");
      setConfirm(false);
      onDone();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box borderWidth="1px" rounded="md" px="3" py="2">
      <Flex justify="space-between" align="center" gap="2" wrap="wrap" cursor="pointer" onClick={() => setOpen(!open)}>
        <HStack gap="2" minW="0">
          {open ? <LuChevronDown /> : <LuChevronRight />}
          <Text fontWeight="medium">v{x.version}</Text>
          <Badge size="sm" colorPalette={isActive ? "green" : "gray"}>{isActive ? "действует" : "архив"}</Badge>
          {x.comment && <Text textStyle="sm" color="fg.muted" truncate>{x.comment}</Text>}
        </HStack>
        <Text textStyle="xs" color="fg.muted">{x.author ?? "система"} · {dateTime(x.createdAt)}</Text>
      </Flex>
      {open && (
        <Box mt="2" ps="6">
          <Stack gap="0.5">
            {x.lines.map((l) => {
              const cur = now.get(l.productId);
              const diff = isActive || !cur ? null : cur.net !== l.net ? `сейчас ${qty(cur.net, cur.unit)}` : null;
              return (
                <Flex key={l.productId} justify="space-between" gap="3" textStyle="sm">
                  <Text>
                    {l.productName}
                    {!isActive && !cur && <Badge size="xs" colorPalette="orange" ms="1.5">сейчас нет</Badge>}
                  </Text>
                  <Text whiteSpace="nowrap">
                    {qty(l.net, l.unit)}{diff && <Text as="span" color="orange.fg" textStyle="xs"> · {diff}</Text>}
                  </Text>
                </Flex>
              );
            })}
            {!isActive && removed.map((l) => (
              <Flex key={`r${l.productId}`} justify="space-between" gap="3" textStyle="sm" color="fg.muted">
                <Text>{l.productName} <Badge size="xs" colorPalette="blue" ms="1.5">добавлен позже</Badge></Text>
                <Text>—</Text>
              </Flex>
            ))}
          </Stack>
          {editable && !isActive && (
            confirm ? (
              <Stack gap="2" mt="3">
                <Input size="sm" placeholder="Почему возвращаем (необязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
                <HStack>
                  <Button size="sm" colorPalette="teal" loading={busy} onClick={restore}>Да, вернуть v{x.version}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Отмена</Button>
                </HStack>
                <Text textStyle="xs" color="fg.muted">Будет создана новая версия с этим составом; уже пробитые заказы не изменятся.</Text>
              </Stack>
            ) : (
              <Button size="sm" variant="outline" mt="3" onClick={(e) => { e.stopPropagation(); setConfirm(true); }}>
                <LuUndo2 /> Вернуть эту версию
              </Button>
            )
          )}
        </Box>
      )}
    </Box>
  );
}
