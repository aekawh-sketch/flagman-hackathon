import { useState, type ReactNode } from "react";
import { Badge, Box, Flex, Table, Text } from "@chakra-ui/react";
import { ProductDrawer } from "./Drill";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../session";
import { money } from "../format";
import { Empty, Loading, Section } from "./ui";

const LEVEL = { bad: "red", warn: "orange", info: "blue", ok: "green" } as const;

/**
 * «Поставлено — съедено — просрочено» (ТЗ 16.1, шаг 7): сколько пришло, сколько ушло в заказы и
 * заготовки, сколько выбросили по сроку. Сверху — где просрочки больше всего: там и надо возить меньше.
 */
export function SupplyReport({ days, from, to, control }: {
  days: number; from?: string; to?: string; control?: ReactNode;
}) {
  const { loc } = useSession();
  const q = useQuery({ queryKey: ["supply", loc, days, from, to], queryFn: () => api.supply(loc, days, from, to) });
  const rows = q.data ?? [];
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const expiredKop = rows.reduce((s, r) => s + r.expiredKop, 0);
  return (
    <Section title="Поставлено — съедено — просрочено" actions={(control || expiredKop > 0) && (
      <Flex gap="2" align="center" wrap="wrap">
        {control}
        {expiredKop > 0 && <Badge colorPalette="red">просрочено на {money(expiredKop)} за {days} дн.</Badge>}
      </Flex>
    )}>
      <Text textStyle="sm" color="fg.muted" mb="3">
        Что привезли, сколько ушло в блюда и сколько пропало по сроку. Если продукт часто списывают просроченным —
        возите меньше или чаще: подсказка считает, сколько реально съедают между поставками. Нажмите на продукт —
        откроются его поставки, блюда и списания со ссылками.
      </Text>
      {q.isLoading ? <Loading /> : !rows.length ? <Empty title="Поставок за период не было" /> : (
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Продукт</Table.ColumnHeader>
              <Table.ColumnHeader hideBelow="sm" textAlign="end">Привезли</Table.ColumnHeader>
              <Table.ColumnHeader hideBelow="sm" textAlign="end">Съели</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="end">Просрочено</Table.ColumnHeader>
              <Table.ColumnHeader hideBelow="xl" textAlign="end" whiteSpace="nowrap">Прочие потери</Table.ColumnHeader>
              <Table.ColumnHeader hideBelow="md" textAlign="end">Сейчас</Table.ColumnHeader>
              <Table.ColumnHeader hideBelow="md">Подсказка</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.slice(0, 30).map((r) => (
              <Table.Row key={r.productId} cursor="pointer" _hover={{ bg: "bg.muted" }}
                         onClick={() => setOpen({ id: r.productId, name: r.productName })}>
                <Table.Cell>
                  <Text fontWeight="medium">{r.productName}</Text>
                  {/* На телефоне «привезли / съели» и подсказка — строками под названием. */}
                  <Text hideFrom="sm" textStyle="xs" color="fg.muted">привезли {r.receivedText} · съели {r.consumedText}</Text>
                  <Text hideFrom="md" textStyle="xs" color={`${LEVEL[r.adviceLevel]}.fg`}>{r.advice}</Text>
                </Table.Cell>
                <Table.Cell hideBelow="sm" textAlign="end" whiteSpace="nowrap">{r.receivedText}</Table.Cell>
                <Table.Cell hideBelow="sm" textAlign="end" whiteSpace="nowrap">{r.consumedText}</Table.Cell>
                <Table.Cell textAlign="end" whiteSpace="nowrap">
                  {r.expired > 0 ? (
                    <Box>
                      <Text color="red.fg">{r.expiredText}</Text>
                      <Text textStyle="xs" color="fg.muted">{Math.round(r.expiredShare * 100)}{" "}% · {money(r.expiredKop)}</Text>
                    </Box>
                  ) : <Text color="fg.muted">—</Text>}
                </Table.Cell>
                <Table.Cell hideBelow="xl" textAlign="end" whiteSpace="nowrap" color="fg.muted">
                  {r.otherLoss > 0 ? r.otherLossText : "—"}
                </Table.Cell>
                <Table.Cell hideBelow="md" textAlign="end" whiteSpace="nowrap">{r.leftText}</Table.Cell>
                <Table.Cell hideBelow="md">
                  {/* Подсказка — фраза, а не метка: в плашке она ломалась на 3–6 строк. */}
                  <Text textStyle="sm" color={`${LEVEL[r.adviceLevel]}.fg`}>{r.advice}</Text>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      <ProductDrawer open={!!open} onClose={() => setOpen(null)} productId={open?.id ?? null} name={open?.name}
                     period={{ days, from, to }} />
    </Section>
  );
}
