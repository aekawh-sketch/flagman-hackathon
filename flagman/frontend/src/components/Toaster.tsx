import { useEffect, useState } from "react";
import { Button, Toaster as ChakraToaster, Portal, Spinner, Stack, Toast, createToaster } from "@chakra-ui/react";

export const toaster = createToaster({ placement: "bottom-end", pauseOnPageIdle: true, max: 5 });

/**
 * Сколько уведомлений на экране и какое из них новое. Хранилище оповещает подписчиков до того,
 * как обновит свой список, поэтому читаем его на следующем такте.
 */
function useVisibleToasts() {
  const [state, setState] = useState({ count: 0, newestId: "" });
  useEffect(() => toaster.subscribe(() => {
    setTimeout(() => {
      const visible = toaster.getVisibleToasts();
      setState({ count: visible.length, newestId: visible[0]?.id ?? "" });
    }, 0);
  }), []);
  return state;
}

export function Toaster() {
  const { count, newestId } = useVisibleToasts();
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: "4" }}>
        {(toast) => (
          <Toast.Root width={{ md: "sm" }}>
            {toast.type === "loading" ? <Spinner size="sm" color="blue.solid" /> : <Toast.Indicator />}
            <Stack gap="1" flex="1" maxWidth="100%">
              {toast.title && <Toast.Title>{toast.title}</Toast.Title>}
              {toast.description && <Toast.Description>{toast.description}</Toast.Description>}
              {/* Действие уведомления — например, «Рассмотреть» у запроса на одобрение. */}
              {toast.action && (
                <Toast.ActionTrigger asChild>
                  <Button size="xs" colorPalette="teal" alignSelf="flex-start" mt="1">{toast.action.label}</Button>
                </Toast.ActionTrigger>
              )}
              {/* Несколько уведомлений — на самом новом (оно ближе всех к краю) кнопка убрать все разом. */}
              {count > 1 && toast.id === newestId && (
                <Button size="xs" variant="surface" alignSelf="flex-start" mt="1"
                        onClick={() => toaster.remove()}>
                  Убрать все ({count})
                </Button>
              )}
            </Stack>
            {/* Крестик — у любого уведомления: сигнал можно закрыть, не дожидаясь, пока исчезнет сам. */}
            <Toast.CloseTrigger aria-label="Закрыть уведомление" />
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  );
}

export const notifyError = (e: unknown) =>
  toaster.create({ type: "error", title: e instanceof Error ? e.message : "Ошибка", closable: true });

export const notifyOk = (title: string, description?: string) =>
  toaster.create({ type: "success", title, description });
