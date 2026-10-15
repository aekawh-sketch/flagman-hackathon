import { Alert, Badge, Box, Card, HStack, List, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { LuFlame } from "react-icons/lu";
import { api } from "../api";
import { useSession } from "../session";
import { money, timeLeft } from "../format";
import { Empty, Loading, PageHeader, Section } from "../components/ui";

export function HotPage() {
  const { loc } = useSession();
  const hot = useQuery({ queryKey: ["hot", loc], queryFn: () => api.hot(loc) });
  return (
    <>
      <PageHeader title="Горячие предложения"
        subtitle="Блюда, продажа которых спасёт продукты, которые иначе пропадут. Пересчёт — после каждого изменения склада и каждые 15 минут." />
      {hot.isLoading ? <Loading rows={5} /> : hot.data?.error ? (
        <Alert.Root status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Горячие предложения пока не считаются</Alert.Title>
            <Alert.Description>{hot.data.error}</Alert.Description>
          </Alert.Content>
        </Alert.Root>
      ) : !hot.data?.offers.length ? (
        <Empty title="Продвигать нечего" description="При текущих продажах все продукты успеют продаться до конца срока" />
      ) : (
        <SimpleGrid columns={{ base: 1, lg: 2 }} gap="4" mb="6">
          {hot.data.offers.map((o) => (
            <Card.Root key={o.variantId} variant="outline" borderColor="orange.muted">
              <Card.Body gap="3">
                <HStack justify="space-between" align="start">
                  <HStack>
                    <Badge colorPalette="orange" variant="solid" size="lg" rounded="full">#{o.rank}</Badge>
                    <Text fontWeight="semibold" textStyle="lg">{o.name}</Text>
                  </HStack>
                  <Text fontWeight="semibold">{money(o.priceKop)}</Text>
                </HStack>
                <HStack gap="4" wrap="wrap">
                  <Box><Text textStyle="xs" color="fg.muted">Под угрозой</Text><Text fontWeight="semibold">{o.productName}: {o.atRiskText}</Text></Box>
                  <Box><Text textStyle="xs" color="fg.muted">Истекает через</Text><Text fontWeight="semibold" color="orange.fg">{timeLeft(o.hoursLeft)}</Text></Box>
                  <Box><Text textStyle="xs" color="fg.muted">Пропадёт без продвижения</Text><Text fontWeight="semibold" color="red.fg">≈ {money(o.lossKop)}</Text></Box>
                  <Box><Text textStyle="xs" color="fg.muted">Порций есть</Text><Text fontWeight="semibold">{o.portions > 999 ? "999+" : o.portions}</Text></Box>
                </HStack>
                <HStack align="start" gap="2" p="3" rounded="md" bg="orange.subtle">
                  <Box color="orange.fg" mt="0.5"><LuFlame /></Box>
                  <Text textStyle="sm">{o.explanation}</Text>
                </HStack>
              </Card.Body>
            </Card.Root>
          ))}
        </SimpleGrid>
      )}
      <Section title="Как считается">
        <Stack gap="2" textStyle="sm" color="fg.muted">
          <List.Root as="ol" gap="1.5">
            <List.Item><b>Что реально пропадёт.</b> Партии идут по FEFO; прогноз продаж до срока каждой партии сначала забирают более ранние. Если продукт и так быстро уходит — продвигать нечего.</List.Item>
            <List.Item><b>Срочность</b> растёт к концу срока: U = 1 / (1 + часов до срока / окно «скоро истекает»).</List.Item>
            <List.Item><b>Ценность одной продажи</b> — сколько рублей продуктов, которые иначе пропадут, спасает порция: дорогой лосось важнее дешёвой картошки.</List.Item>
            <List.Item><b>Разнообразие.</b> Выбрали лучшее блюдо → считаем, что продвижение даст ~30% к обычным продажам → вычитаем спасённое → пересчитываем остальных. Продукт из пяти блюд не учитывается пять раз.</List.Item>
          </List.Root>
          <Text>Допущение о реакции гостей (+30% к продажам блюда, общий спрос не растёт) — настраиваемое и указано явно.</Text>
        </Stack>
      </Section>
    </>
  );
}
