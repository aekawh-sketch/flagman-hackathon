import { Badge, Box, Card, EmptyState, Flex, Heading, HStack, SegmentGroup, Skeleton, Stack, Text, VStack } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { STATUS, timeLeft } from "../format";
import type { BatchStatus } from "../types";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Flex align={{ base: "start", md: "center" }} justify="space-between" gap="4" mb="5"
          direction={{ base: "column", md: "row" }}>
      <Box>
        <Heading size="xl" letterSpacing="-0.01em">{title}</Heading>
        {subtitle && <Text color="fg.muted" mt="1" textStyle="sm">{subtitle}</Text>}
      </Box>
      {actions && <HStack gap="2" wrap="wrap" flexShrink={0} w={{ base: "full", md: "auto" }}>{actions}</HStack>}
    </Flex>
  );
}

export function StatusBadge({ status, blocked }: { status: BatchStatus | null; blocked?: boolean }) {
  if (!status && !blocked) return null;
  const s = blocked ? STATUS.BLOCKED : STATUS[status!];
  return <Badge colorPalette={s.palette} variant="subtle">{s.label}</Badge>;
}

/** Таймер до истечения срока: цвет зависит от статуса партии. */
export function Countdown({ hours, status }: { hours: number; status?: BatchStatus }) {
  const palette = status ? STATUS[status].palette : hours <= 0 ? "red" : "gray";
  return (
    <Text as="span" fontVariantNumeric="tabular-nums" fontWeight="medium" whiteSpace="nowrap"
          color={palette === "gray" ? "fg.muted" : `${palette}.fg`}>
      {timeLeft(hours)}
    </Text>
  );
}

export function Kpi({ label, value, hint, palette, onClick }: { label: string; value: ReactNode; hint?: ReactNode;
  palette?: string; onClick?: () => void }) {
  return (
    <Card.Root variant="outline" size="sm" cursor={onClick ? "pointer" : undefined} onClick={onClick}
               _hover={onClick ? { borderColor: "border.emphasized" } : undefined}>
      <Card.Body gap="1">
        <Text textStyle="xs" color="fg.muted" textTransform="uppercase" letterSpacing="0.04em">{label}</Text>
        <Text textStyle="2xl" fontWeight="semibold" fontVariantNumeric="tabular-nums"
              color={palette ? `${palette}.fg` : undefined}>{value}</Text>
        {hint && <Text textStyle="xs" color="fg.muted">{hint}</Text>}
      </Card.Body>
    </Card.Root>
  );
}

export function Section({ title, actions, children, ...rest }: { title: ReactNode; actions?: ReactNode;
  children: ReactNode } & Record<string, unknown>) {
  return (
    <Card.Root variant="outline" size={{ base: "sm", md: "md" }} {...rest}>
      <Card.Header pb="2">
        {/* На узком экране кнопки раздела уходят под заголовок, а не за край карточки. */}
        <Flex justify="space-between" align="center" columnGap="3" rowGap="2" wrap="wrap">
          <Heading size="md">{title}</Heading>
          {actions}
        </Flex>
      </Card.Header>
      <Card.Body pt="2">{children}</Card.Body>
    </Card.Root>
  );
}

/**
 * Переключатель «Новые / Все / …». На телефоне — компактнее и растягивается на всю ширину,
 * чтобы подписи не вылезали за экран и не переносились.
 */
export function Segments({ value, onChange, items }: { value: string; onChange: (v: string) => void;
  items: { value: string; label: string }[] }) {
  return (
    <SegmentGroup.Root size={{ base: "xs", sm: "sm" }} value={value} onValueChange={(e) => e.value && onChange(e.value)}
                       maxW="full" w={{ base: "full", sm: "auto" }}>
      <SegmentGroup.Indicator />
      <SegmentGroup.Items items={items} flex={{ base: "1", sm: "initial" }} justifyContent="center" whiteSpace="nowrap" px={{ base: "2", sm: "3" }} />
    </SegmentGroup.Root>
  );
}

export function Empty({ title, description, icon, action }: {
  title: string; description?: string; icon?: ReactNode; action?: ReactNode;
}) {
  return (
    <EmptyState.Root size="sm">
      <EmptyState.Content>
        {icon && <EmptyState.Indicator>{icon}</EmptyState.Indicator>}
        <VStack textAlign="center">
          <EmptyState.Title>{title}</EmptyState.Title>
          {description && <EmptyState.Description>{description}</EmptyState.Description>}
        </VStack>
        {action}
      </EmptyState.Content>
    </EmptyState.Root>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <Stack gap="2">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} height="10" rounded="md" />)}
    </Stack>
  );
}

/** Полоса «сколько срока осталось». */
export function LifeBar({ share, status }: { share: number; status: BatchStatus }) {
  return (
    <Box h="1.5" w="full" bg="bg.muted" rounded="full" overflow="hidden">
      <Box h="full" w={`${Math.max(2, Math.min(100, share * 100))}%`} bg={`${STATUS[status].palette}.solid`} />
    </Box>
  );
}
