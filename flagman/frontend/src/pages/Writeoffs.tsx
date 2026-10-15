import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Badge, Box, Button, Card, Flex, HStack, SimpleGrid, Stack, Tabs, Text } from "@chakra-ui/react";
import { LuPlus, LuUndo2 } from "react-icons/lu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, glue, money, WRITEOFF_REASON } from "../format";
import type { WriteoffRequest } from "../types";
import { Empty, Loading, PageHeader, Segments } from "../components/ui";
import { notifyError, notifyOk } from "../components/Toaster";
import { ExpiredPanel } from "../components/ExpiredPanel";
import { PhotoStrip } from "../components/PhotoViewer";
import { NewWriteoffDialog } from "../components/NewWriteoffDialog";

const STATUS: Record<string, { label: string; palette: string }> = {
  PENDING: { label: "ждёт подписи", palette: "orange" },
  EXECUTED: { label: "списано", palette: "gray" },
  REJECTED: { label: "отклонено", palette: "red" },
};

/** Строки одной групповой заявки (напиток по техкарте, продукт из нескольких партий) — одна карточка. */
export function groupRequests(list: WriteoffRequest[]): { head: WriteoffRequest; rows: WriteoffRequest[] }[] {
  const out: { head: WriteoffRequest; rows: WriteoffRequest[] }[] = [];
  const byGroup = new Map<string, { head: WriteoffRequest; rows: WriteoffRequest[] }>();
  for (const r of list) {
    const g = r.groupId ? byGroup.get(r.groupId) : undefined;
    if (g) {
      g.rows.push(r);
      continue;
    }
    const card = { head: r, rows: [r] };
    if (r.groupId) byGroup.set(r.groupId, card);
    out.push(card);
  }
  return out;
}

/**
 * Заявки на списание (ТЗ 6.5) и возврат поставщику (ТЗ 16.7): подписывает управляющий или админ, свою — нельзя;
 * пока заявка ждёт, это количество не продаётся.
 */
export function WriteoffsPage() {
  const { loc, can } = useSession();
  // Вкладка и статус — из адреса: ссылка из «Подозрительного» открывает все заявки, «Назад» — ту же вкладку.
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(() => {
    const s = params.get("status");
    return s && ["PENDING", "EXECUTED", "REJECTED", "ALL"].includes(s) ? s : "PENDING";
  });
  const canReturn = can("STOREKEEPER", "MANAGER", "ADMIN");
  const tab = canReturn && params.get("tab") === "returns" ? "returns" : "writeoffs";
  // Заявку на списание создаёт сам кладовщик или повар (и управляющий) — решает управляющий или админ.
  const canWriteoff = can("COOK", "STOREKEEPER", "MANAGER");
  const [writeoffOpen, setWriteoffOpen] = useState(false);
  const pendingReturns = useQuery({
    queryKey: ["returns", loc, "PENDING"], enabled: canReturn,
    queryFn: () => api.returns(loc, { status: "PENDING" }),
  });
  const pendingCount = pendingReturns.data?.length ?? 0;

  return (
    <>
      <PageHeader title="Заявки на списание и возврат"
        subtitle="Списание и возврат поставщику — только заявкой с фото. Подписывает управляющий или админ, свою подписать нельзя; пока заявка ждёт, товар не продаётся."
        actions={<>
          {canWriteoff && (
            <Button size="sm" colorPalette="red" onClick={() => setWriteoffOpen(true)}><LuPlus /> Новая заявка на списание</Button>
          )}
          <Segments value={status} onChange={setStatus} items={[{ value: "PENDING", label: "Ждут" },
            { value: "EXECUTED", label: tab === "returns" ? "Возвращено" : "Списано" }, { value: "REJECTED", label: "Отклонено" },
            { value: "ALL", label: "Все" }]} />
        </>} />
      {canReturn ? (
        <Tabs.Root value={tab} variant="line" lazyMount
                   onValueChange={(e) => setParams(e.value === "returns" ? { tab: "returns" } : {}, { replace: true })}>
          <Tabs.List mb="4">
            <Tabs.Trigger value="writeoffs">Списания</Tabs.Trigger>
            <Tabs.Trigger value="returns">
              Возвраты поставщику
              {pendingCount > 0 && <Badge size="sm" colorPalette="orange" variant="solid">{pendingCount}</Badge>}
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="writeoffs" pt="0">
            <WriteoffList status={status} onNew={canWriteoff ? () => setWriteoffOpen(true) : undefined} />
          </Tabs.Content>
          <Tabs.Content value="returns" pt="0"><ReturnList status={status} /></Tabs.Content>
        </Tabs.Root>
      ) : <WriteoffList status={status} onNew={canWriteoff ? () => setWriteoffOpen(true) : undefined} />}
      <NewWriteoffDialog open={writeoffOpen} onClose={() => setWriteoffOpen(false)} />
    </>
  );
}

function WriteoffList({ status, onNew }: { status: string; onNew?: () => void }) {
  const { loc, me, can } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["writeoffs", loc, status], queryFn: () => api.writeoffs(loc, status === "ALL" ? undefined : status) });

  const decide = async (id: number, approve: boolean) => {
    const comment = approve ? "" : window.prompt("Причина отказа") ?? "";
    try {
      await (approve ? api.approveWriteoff(loc, id, comment) : api.rejectWriteoff(loc, id, comment));
      notifyOk(approve ? "Списано" : "Отклонено — количество вернулось в продажу");
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <Box mb="4"><ExpiredPanel /></Box>
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <Empty title="Заявок нет" description={onNew ? "Испортилось, разбилось или пролили — оформите заявку с фото" : undefined}
               action={onNew && <Button size="sm" colorPalette="red" onClick={onNew}><LuPlus /> Новая заявка на списание</Button>} />
      ) : (
        <SimpleGrid columns={{ base: 1, lg: 2 }} gap="3">
          {groupRequests(list.data).map(({ head: r, rows }) => {
            const left = Math.max(...rows.map((x) => x.leftPercent));
            // Свежесть подозрительна, когда продукт объявляют испорченным; разбитое и пролитое свежим и бывает (как правило A2)
            const fresh = left > 50 && r.reason !== "DAMAGED";
            const cost = rows.reduce((sum, x) => sum + x.costKop, 0);
            const many = rows.length > 1 || !!r.dishName;
            const title = r.dishName ? `${r.dishName} ×${r.dishQty}`
              : `${r.productName} · ${rows.map((x) => x.qtyText).join(" + ")}`;
            return (
              <Card.Root key={r.id} variant="outline" borderColor={fresh ? "red.muted" : undefined}>
                <Card.Body>
                  <HStack align="start" gap={{ base: "3", sm: "4" }}>
                    {r.hasPhoto && can("STOREKEEPER", "MANAGER", "ADMIN") && (
                      <PhotoStrip srcs={Array.from({ length: r.photoCount || 1 }, (_, i) => api.writeoffPhotoUrl(loc, r.id, i))}
                                  alt={`Фото к заявке: ${title}`} size="16" max={2} />
                    )}
                    <Stack gap="1" flex="1" minW="0">
                      {/* На узком экране статус — над названием, чтобы название не сжималось в колонку по слову. */}
                      <Flex justify="space-between" align="start" gap="2" direction={{ base: "column-reverse", sm: "row" }}>
                        <Text fontWeight="semibold">{glue(title)}</Text>
                        <Badge colorPalette={STATUS[r.status].palette} flexShrink={0}>{STATUS[r.status].label}</Badge>
                      </Flex>
                      <Text textStyle="sm">
                        {WRITEOFF_REASON[r.reason]}{r.comment ? ` — ${r.comment}` : ""} · {money(cost)}
                      </Text>
                      <Text textStyle="sm" color="fg.muted">
                        {r.createdByName} · {dateTime(r.createdAt)}{!many && ` · партия ${r.batchLabel}`}
                        {r.deliveryNumber && ` · из поставки ${r.deliveryNumber}`}
                      </Text>
                      {/* Напиток или продукт из нескольких партий: что именно спишется — по строкам */}
                      {many && (
                        <Stack gap="0.5" pl="3" borderLeftWidth="2px" borderColor="border" my="1">
                          {rows.map((x) => (
                            <Text key={x.id} textStyle="xs" color="fg.muted">
                              {x.productName} {x.qtyText} · партия {x.batchLabel} · {x.leftPercent}% срока
                            </Text>
                          ))}
                        </Stack>
                      )}
                      <Text textStyle="sm" color={fresh ? "red.fg" : "fg.muted"} fontWeight={fresh ? "semibold" : undefined}>
                        {many ? "Самая свежая партия в заявке: " : "На момент заявки у партии оставалось "}{left}% срока
                        {fresh ? " — продукт был свежим, а списан как испорченный" : ""}
                      </Text>
                      {r.decidedByName && (
                        <Text textStyle="xs" color="fg.muted">Решил(а): {r.decidedByName}{r.decisionComment ? ` — ${r.decisionComment}` : ""}</Text>
                      )}
                    </Stack>
                  </HStack>
                  {r.status === "PENDING" && can("MANAGER", "ADMIN") && (
                    <Box mt="3">
                      {r.createdBy === me?.id ? (
                        <Text textStyle="sm" color="fg.muted">Это ваша заявка — подписывает другой управляющий</Text>
                      ) : (
                        <HStack>
                          <Button size="sm" colorPalette="red" onClick={() => decide(r.id, true)}>Подписать списание</Button>
                          <Button size="sm" variant="outline" onClick={() => decide(r.id, false)}>Отклонить</Button>
                        </HStack>
                      )}
                    </Box>
                  )}
                </Card.Body>
              </Card.Root>
            );
          })}
        </SimpleGrid>
      )}
    </>
  );
}

const RETURN_STATUS: Record<string, { label: string; palette: string }> = {
  PENDING: { label: "ждёт подтверждения", palette: "orange" },
  EXECUTED: { label: "возвращено", palette: "gray" },
  REJECTED: { label: "отклонено", palette: "red" },
};

/** Заявки на возврат поставщику: что, из какой поставки и партии, почему; подтверждает не автор. */
function ReturnList({ status }: { status: string }) {
  const { loc, me, can } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["returns", loc, status],
    queryFn: () => api.returns(loc, { status: status === "ALL" ? undefined : status }),
  });
  const decide = async (id: number, approve: boolean) => {
    const comment = approve ? "" : window.prompt("Причина отказа") ?? "";
    try {
      await (approve ? api.approveReturn(loc, id, comment) : api.rejectReturn(loc, id, comment));
      notifyOk(approve ? "Возврат подтверждён — товар ушёл со склада" : "Отклонено — количество вернулось в продажу");
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === loc });
    } catch (e) {
      notifyError(e);
    }
  };
  if (list.isLoading) return <Loading />;
  if (!list.data?.length) {
    return <Empty title="Заявок на возврат нет"
                  description="Возврат оформляется из поставки: «Приёмка» → «Последние поставки» → поставка → «Оформить возврат»"
                  action={<Button size="sm" variant="outline" onClick={() => navigate(`/${loc}/acceptance`)}>
                    <LuUndo2 /> Открыть приёмку</Button>} />;
  }
  return (
    <SimpleGrid columns={{ base: 1, lg: 2 }} gap="3">
      {list.data.map((r) => (
        <Card.Root key={r.id} variant="outline">
          <Card.Body>
            <HStack align="start" gap={{ base: "3", sm: "4" }}>
              <PhotoStrip srcs={Array.from({ length: r.photoCount || 1 }, (_, i) => api.returnPhotoUrl(loc, r.id, i))}
                          alt={`Фото к возврату по поставке ${r.deliveryNumber}`} size="16" max={2} />
              <Stack gap="1" flex="1" minW="0">
                <Flex justify="space-between" align="start" gap="2" direction={{ base: "column-reverse", sm: "row" }}>
                  <Text fontWeight="semibold">
                    Поставка <Text as="span" fontFamily="mono">{r.deliveryNumber}</Text>{r.supplier ? ` · ${r.supplier}` : ""}
                  </Text>
                  <Badge colorPalette={RETURN_STATUS[r.status].palette} flexShrink={0}>{RETURN_STATUS[r.status].label}</Badge>
                </Flex>
                <Text textStyle="sm">{r.reasonText}{r.comment ? ` — ${r.comment}` : ""} · {money(r.costKop)}</Text>
                <Stack gap="0.5" pl="3" borderLeftWidth="2px" borderColor="border" my="1">
                  {r.lines.map((l) => (
                    <Text key={l.batchId} textStyle="xs" color="fg.muted">
                      {glue(`${l.productName} ${l.qtyText}`)} · партия {l.batchLabel} · {money(l.costKop)}
                    </Text>
                  ))}
                </Stack>
                <Text textStyle="sm" color="fg.muted">{r.createdByName} · {dateTime(r.createdAt)}</Text>
                {r.decidedByName && (
                  <Text textStyle="xs" color="fg.muted">Решил(а): {r.decidedByName}{r.decisionComment ? ` — ${r.decisionComment}` : ""}</Text>
                )}
              </Stack>
            </HStack>
            {r.status === "PENDING" && can("MANAGER", "ADMIN") && (
              <Box mt="3">
                {r.createdBy === me?.id ? (
                  <Text textStyle="sm" color="fg.muted">Это ваша заявка — подтверждает другой управляющий или админ</Text>
                ) : (
                  <HStack>
                    <Button size="sm" colorPalette="teal" onClick={() => decide(r.id, true)}>Подтвердить возврат</Button>
                    <Button size="sm" variant="outline" onClick={() => decide(r.id, false)}>Отклонить</Button>
                  </HStack>
                )}
              </Box>
            )}
            {r.status === "PENDING" && !can("MANAGER", "ADMIN") && (
              <Text textStyle="xs" color="fg.muted" mt="2">Ждёт подтверждения управляющего или админа — пока товар не продаётся</Text>
            )}
          </Card.Body>
        </Card.Root>
      ))}
    </SimpleGrid>
  );
}
