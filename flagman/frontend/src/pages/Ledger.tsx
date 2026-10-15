import { useState } from "react";
import { Alert, Button, Code, HStack, Table, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { LuShieldCheck } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { dateTime, money } from "../format";
import { Loading, PageHeader } from "../components/ui";
import { Choice } from "../components/Choice";

const TYPES = ["RECEIPT", "ORDER", "ORDER_RETURN", "PRODUCTION_USE", "PRODUCTION_OUT", "OPEN_OUT", "OPEN_IN",
  "WRITEOFF_EXPIRED", "WRITEOFF_SPOILED", "WRITEOFF_DAMAGED", "WRITEOFF_OTHER", "WRITEOFF_RECALL", "WRITEOFF_SHORTAGE",
  "SURPLUS", "RETURN_SUPPLIER"];

/** Журнал движений (ТЗ 6.3–6.4): только добавление, хэш-цепочка, проверка целостности. */
export function LedgerPage() {
  const { loc } = useSession();
  const [type, setType] = useState("");
  const [beforeSeq, setBeforeSeq] = useState<number | undefined>();
  const rows = useQuery({ queryKey: ["ledger", loc, type, beforeSeq], queryFn: () => api.ledger(loc, { type, beforeSeq, limit: 100 }) });
  const verify = useQuery({ queryKey: ["verify", loc], queryFn: () => api.verify(loc), enabled: false });

  return (
    <>
      <PageHeader title="Журнал движений"
        subtitle="Записи нельзя изменить или удалить — даже напрямую в базе. Каждая хранит хэш предыдущей: подделка видна сразу."
        actions={<Button size="sm" colorPalette="teal" loading={verify.isFetching} onClick={() => verify.refetch()}>
          <LuShieldCheck /> Проверить целостность</Button>} />
      {verify.data && (
        <Alert.Root status={verify.data.ok ? "success" : "error"} mb="4">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{verify.data.ok ? `Журнал цел: проверено ${verify.data.checked} записей` : `Цепочка нарушена на записи №${verify.data.brokenAtSeq}`}</Alert.Title>
            <Alert.Description>Хэш головы цепочки: <Code>{verify.data.headHash.slice(0, 24)}…</Code></Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}
      <HStack mb="3">
        <Choice maxW="xs" size="sm" label="Тип операции" value={type} onChange={(v) => { setType(v); setBeforeSeq(undefined); }}
                options={[{ value: "", label: "Все типы" }, ...TYPES.map((t) => ({ value: t, label: t }))]} />
      </HStack>
      {rows.isLoading ? <Loading rows={10} /> : (
        <Table.ScrollArea borderWidth="1px" rounded="md" bg="bg.panel">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader hideBelow="md">№</Table.ColumnHeader>
                <Table.ColumnHeader>Когда</Table.ColumnHeader>
                <Table.ColumnHeader>Тип</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md">Партия</Table.ColumnHeader>
                <Table.ColumnHeader textAlign="end" whiteSpace="nowrap">Кол-во</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="md" textAlign="end">Сумма</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="xl">Кто</Table.ColumnHeader>
                <Table.ColumnHeader hideBelow="xl">Хэш</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.data?.map((r) => (
                <Table.Row key={r.id}>
                  <Table.Cell hideBelow="md" fontFamily="mono">{r.seq}</Table.Cell>
                  <Table.Cell whiteSpace={{ base: "normal", md: "nowrap" }} textStyle="sm" verticalAlign="top">{dateTime(r.at)}</Table.Cell>
                  <Table.Cell textStyle="sm">
                    {r.typeTitle}
                    {/* Скрытые на узком экране колонки — строками под типом. */}
                    <Text hideFrom="md" textStyle="xs" color="fg.muted">
                      {r.productName} <Text as="span" fontFamily="mono">{r.batchLabel}</Text>
                    </Text>
                    <Text hideFrom="xl" textStyle="xs" color="fg.muted">{r.actor}</Text>
                  </Table.Cell>
                  <Table.Cell hideBelow="md" textStyle="sm">{r.productName} <Text as="span" color="fg.muted" fontFamily="mono">{r.batchLabel}</Text></Table.Cell>
                  <Table.Cell textAlign="end" color={r.qty < 0 ? "red.fg" : "green.fg"} whiteSpace="nowrap" verticalAlign="top">
                    {r.qty > 0 ? "+" : ""}{r.qtyText}
                    <Text hideFrom="md" textStyle="xs" color="fg.muted">{money(Math.abs(r.costKop))}</Text>
                  </Table.Cell>
                  <Table.Cell hideBelow="md" textAlign="end" whiteSpace="nowrap">{money(Math.abs(r.costKop))}</Table.Cell>
                  <Table.Cell hideBelow="xl" textStyle="sm">{r.actor}</Table.Cell>
                  <Table.Cell hideBelow="xl"><Code size="sm" title={r.hash}>{r.hash.slice(0, 10)}</Code></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
      {!!rows.data?.length && (
        <HStack mt="3" justify="center">
          <Button size="sm" variant="outline" onClick={() => setBeforeSeq(undefined)} disabled={!beforeSeq}>В начало</Button>
          <Button size="sm" variant="outline" onClick={() => setBeforeSeq(rows.data![rows.data!.length - 1].seq)}>Раньше</Button>
        </HStack>
      )}
    </>
  );
}
