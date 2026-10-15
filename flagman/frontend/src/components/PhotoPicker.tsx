import { useEffect, useRef, useState } from "react";
import { Box, chakra, CloseButton, Flex, Stack, Text } from "@chakra-ui/react";
import { LuCamera, LuImagePlus } from "react-icons/lu";
import { PhotoThumb } from "./PhotoViewer";

export const MAX_PHOTOS = 10;
const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * Несколько фото к заявке, возврату или накладной (ТЗ 16.8): «Снять» открывает камеру, «Добавить» — галерею с
 * выбором сразу нескольких. Лимита «5 МБ» нет. У каждого фото — превью с приближением и крестик «убрать».
 */
export function PhotoPicker({ files, onChange, max = MAX_PHOTOS, label = "фото" }: {
  files: File[]; onChange: (files: File[]) => void; max?: number; label?: string;
}) {
  // Адреса превью создаются и отзываются в одном эффекте: при повторном запуске эффектов (строгий режим,
  // горячая перезагрузка) они пересоздаются, а не остаются отозванными — иначе превью ломается.
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made = files.map((f) => URL.createObjectURL(f));
    setUrls(made);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const add = (list: FileList | null) => {
    if (!list?.length) return;
    // Одинаковый файл, выбранный дважды, не задваиваем.
    const known = new Set(files.map((f) => `${f.name}|${f.size}|${f.lastModified}`));
    const fresh = [...list].filter((f) => !known.has(`${f.name}|${f.size}|${f.lastModified}`));
    onChange([...files, ...fresh].slice(0, max));
  };
  const full = files.length >= max;
  const tile = { w: "20", h: "20", rounded: "md", borderWidth: "1px", borderStyle: "dashed", display: "grid",
    placeItems: "center", cursor: "pointer", color: "fg.muted", _hover: { bg: "bg.muted", color: "fg" } } as const;
  return (
    <Stack gap="1.5" w="full">
      <Flex gap="2" wrap="wrap">
        {files.map((f, i) => urls[i] && (
          <Box key={`${f.name}|${f.size}|${f.lastModified}`} position="relative">
            <PhotoThumb src={urls[i]} srcs={urls} index={i} alt={`${label} ${i + 1}`} size="20" />
            <CloseButton size="2xs" position="absolute" top="-2" right="-2" rounded="full" bg="bg.panel" borderWidth="1px"
                         aria-label={`Убрать ${label} ${i + 1}`} onClick={() => onChange(files.filter((_, j) => j !== i))} />
          </Box>
        ))}
        {!full && (
          <>
            <chakra.button type="button" {...tile} onClick={() => camera.current?.click()} aria-label="Снять фото камерой">
              <Stack gap="0.5" align="center"><LuCamera /><Text textStyle="2xs">Снять</Text></Stack>
            </chakra.button>
            <chakra.button type="button" {...tile} onClick={() => gallery.current?.click()} aria-label="Добавить фото из галереи">
              <Stack gap="0.5" align="center"><LuImagePlus /><Text textStyle="2xs">Добавить</Text></Stack>
            </chakra.button>
          </>
        )}
      </Flex>
      <input ref={camera} type="file" accept={ACCEPT} capture="environment" hidden
             onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      <input ref={gallery} type="file" accept={ACCEPT} multiple hidden
             onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      <Text textStyle="xs" color="fg.muted">
        {files.length
          ? `${files.length} из ${max} · нажмите на фото, чтобы рассмотреть; крестик — убрать`
          : `Можно несколько — до ${max}, любого размера`}
      </Text>
    </Stack>
  );
}
