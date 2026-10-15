import { useState } from "react";
import { Badge, Button, Code, Field, Grid, HStack, Input, Stack, Table, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { dateTime, ROLE, roleOptions } from "../format";
import type { Invite, TenantLocation } from "../types";
import { Section } from "./ui";
import { Choice } from "./Choice";
import { notifyError, notifyOk } from "./Toaster";

const STATUS: Record<string, { label: string; palette: string }> = {
  ACTIVE: { label: "ждёт", palette: "blue" }, ACCEPTED: { label: "принято", palette: "green" },
  REVOKED: { label: "отозвано", palette: "gray" }, EXPIRED: { label: "истекло", palette: "gray" },
};

/**
 * Приглашения в предприятие (ТЗ 16.4, 16.9): список ссылок и форма «роль + точка + для кого».
 * Один и тот же блок у админа предприятия и в админке платформы — отличаются только методы API.
 */
export function InvitePanel({ queryKey, list, create, revoke, locations, title, intro, defaultRole = "COOK", stacked }: {
  queryKey: unknown[];
  list: () => Promise<Invite[]>;
  create: (role: string, locationId: string | null, note: string) => Promise<{ token: string }>;
  revoke: (id: number) => Promise<unknown>;
  locations: TenantLocation[] | undefined;
  title?: string;
  intro: React.ReactNode;
  defaultRole?: string;
  /** В диалоге — колонки друг под другом */
  stacked?: boolean;
}) {
  const qc = useQueryClient();
  const invites = useQuery({ queryKey, queryFn: list });
  const [role, setRole] = useState(defaultRole);
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const locationName = (id: string) => locations?.find((l) => l.id === id)?.name ?? id;
  const submit = async () => {
    try {
      const r = await create(role, location || null, note);
      setLink(`${window.location.origin}/invite/${r.token}`);
      setNote("");
      qc.invalidateQueries({ queryKey });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Grid templateColumns={{ base: "1fr", xl: stacked ? "1fr" : "1.4fr 1fr" }} gap="4" alignItems="start">
      <Section title={title ?? "Приглашения"}>
        {!invites.data?.length ? <Text color="fg.muted" textStyle="sm">Пока ни одного</Text> : (
          <Table.Root size="sm">
            <Table.Body>
              {invites.data.map((i) => (
                <Table.Row key={i.id}>
                  <Table.Cell>
                    <Text fontWeight="medium">{ROLE[i.role]}{i.note ? ` · ${i.note}` : ""}</Text>
                    <Text textStyle="xs" color="fg.muted">
                      {i.locationId ? locationName(i.locationId) : "все точки"}
                      {" · "}{i.createdBy}, {dateTime(i.createdAt)}
                      {i.acceptedBy && ` · принял ${i.acceptedBy}`}
                    </Text>
                  </Table.Cell>
                  <Table.Cell textAlign="end">
                    <HStack justify="end" gap="2">
                      <Badge colorPalette={STATUS[i.status].palette}>{STATUS[i.status].label}</Badge>
                      {i.status === "ACTIVE" && (
                        <Button size="xs" variant="outline" colorPalette="red" onClick={async () => {
                          await revoke(i.id).catch(notifyError);
                          qc.invalidateQueries({ queryKey });
                        }}>Отозвать</Button>
                      )}
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </Section>
      <Section title="Пригласить сотрудника">
        <Stack gap="3">
          <Text textStyle="sm" color="fg.muted">{intro}</Text>
          <Choice label="Роль" value={role} onChange={setRole} options={roleOptions()} />
          <Choice label="Точка" value={location} onChange={setLocation}
                  options={[{ value: "", label: "Все точки" }, ...(locations ?? []).map((l) => ({ value: l.id, label: l.name }))]} />
          <Field.Root><Field.Label>Для кого (заметка)</Field.Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Новый повар Мария" /></Field.Root>
          <Button colorPalette="teal" onClick={submit}>Создать ссылку</Button>
          {link && <InviteLink link={link} />}
        </Stack>
      </Section>
    </Grid>
  );
}

/** Ссылка показывается один раз — в базе только её хэш. */
export function InviteLink({ link }: { link: string }) {
  return (
    <Stack p="3" rounded="md" bg="yellow.subtle" gap="2">
      <Text textStyle="sm" fontWeight="semibold">Ссылка показывается один раз — в базе только её хэш. Действует 7 дней:</Text>
      <Code wordBreak="break-all">{link}</Code>
      <Button size="xs" variant="outline" alignSelf="start" onClick={() => {
        navigator.clipboard?.writeText(link).then(() => notifyOk("Ссылка скопирована")).catch(() => undefined);
      }}>Скопировать</Button>
    </Stack>
  );
}
