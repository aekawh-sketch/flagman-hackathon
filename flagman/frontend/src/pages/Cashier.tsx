import { Box, Button, Card, Center, Stack, Text } from "@chakra-ui/react";
import { LuExternalLink, LuMonitorSmartphone } from "react-icons/lu";
import { useSession } from "../session";

/**
 * Кассы во Флагмане нет: склад — не касса. Кассир работает в панели ресторанов (сервер ИСТОК, localhost:3001/panel —
 * общая для всех предприятий) и входит туда тем же логином и паролем, что выдал админ, выбирая место работы.
 * Заказы оттуда приходят во Флагман: «всё или ничего», «осталось N», стоп-лист — те же.
 */
export function CashierPage() {
  const { me, config } = useSession();
  const url = config?.posUrl;
  return (
    <Center minH="60vh">
      <Card.Root maxW="lg" w="full">
        <Card.Body gap="4">
          <Box color="teal.fg" fontSize="3xl"><LuMonitorSmartphone /></Box>
          <Text textStyle="xl" fontWeight="semibold">Касса — в панели ресторана</Text>
          <Text color="fg.muted" textStyle="sm">
            Заказы пробиваются в панели персонала ресторана — там же столы, самовывоз, доставка и оплата.
            Войдите туда тем же логином{me?.login ? <> (<b>{me.login}</b>)</> : ""} и паролем, что и сюда, и выберите
            {me?.tenantName ? <> «{me.tenantName}»</> : " своё предприятие"} и точку.
            Меню, остатки, стоп-лист и «осталось N» касса берёт отсюда, со склада.
          </Text>
          {url ? (
            <Stack gap="2">
              <Button asChild colorPalette="teal" size="lg">
                <a href={url} target="_blank" rel="noopener noreferrer"><LuExternalLink /> Открыть кассу</a>
              </Button>
              <Text textStyle="xs" color="fg.subtle" wordBreak="break-all">{url}</Text>
            </Stack>
          ) : (
            <Text textStyle="sm">Адрес кассы не задан — попросите админа указать его в «Админке → Настройки».</Text>
          )}
        </Card.Body>
      </Card.Root>
    </Center>
  );
}
