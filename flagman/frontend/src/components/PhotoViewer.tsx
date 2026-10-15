import { useCallback, useEffect, useRef, useState } from "react";
import { Box, chakra, Dialog, HStack, IconButton, Image, Portal, Text } from "@chakra-ui/react";
import { LuChevronLeft, LuChevronRight, LuMaximize, LuMinus, LuPlus, LuX, LuZoomIn } from "react-icons/lu";

const MIN = 1;
const MAX = 6;

interface View {
  scale: number;
  x: number;
  y: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Фото на весь экран с приближением: колесо мыши (к курсору), щипок двумя пальцами, двойной щелчок или касание,
 * кнопки «+»/«−». Приближенное фото перетаскивается. Esc — закрыть. Несколько фото ({@code srcs}) листаются
 * стрелками на экране и клавиатуре или свайпом, пока фото не приближено.
 */
export function PhotoViewer({ src, srcs, start = 0, alt, open, onClose }: {
  src?: string | null; srcs?: string[]; start?: number; alt?: string; open: boolean; onClose: () => void;
}) {
  const list = srcs?.length ? srcs : src ? [src] : [];
  const [idx, setIdx] = useState(start);
  useEffect(() => { if (open) setIdx(start); }, [open, start]);
  const current = list[Math.min(idx, list.length - 1)] ?? null;
  const many = list.length > 1;
  const step = useCallback((d: number) => setIdx((i) => (i + d + list.length) % list.length), [list.length]);
  const swipe = useRef<number | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; mid: { x: number; y: number }; vx: number; vy: number } | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    if (open) setView({ scale: 1, x: 0, y: 0 });
  }, [open, current]);

  /** Точка относительно центра области — вокруг неё и приближаем. */
  const local = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: cx - r.left - r.width / 2, y: cy - r.top - r.height / 2 };
  };

  const zoomAt = useCallback((next: number, px: number, py: number) => {
    setView((v) => {
      const s = clamp(next, MIN, MAX);
      if (s === MIN) return { scale: MIN, x: 0, y: 0 };
      const k = s / v.scale;
      return { scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    const p = local(e.clientX, e.clientY);
    zoomAt(view.scale * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const [a, b] = pts;
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale, mid, vx: view.x, vy: view.y };
      drag.current = null;
    } else if (pts.length === 1) {
      drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      swipe.current = view.scale === 1 ? e.clientX : null;   // свайп листает, только пока фото не приближено
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 2 && gesture.current) {
      const [a, b] = pts;
      const g = gesture.current;
      const s = clamp(g.scale * Math.hypot(a.x - b.x, a.y - b.y) / g.dist, MIN, MAX);
      const k = s / g.scale;
      setView(s === MIN ? { scale: MIN, x: 0, y: 0 } : { scale: s, x: g.mid.x - (g.mid.x - g.vx) * k, y: g.mid.y - (g.mid.y - g.vy) * k });
    } else if (pts.length === 1 && drag.current && view.scale > 1) {
      const d = drag.current;
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (many && swipe.current !== null && pointers.current.size === 1) {
      const dx = e.clientX - swipe.current;
      if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    }
    swipe.current = null;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) drag.current = null;
  };

  const onDouble = (e: React.MouseEvent) => {
    const p = local(e.clientX, e.clientY);
    zoomAt(view.scale > 1.2 ? 1 : 2.5, p.x, p.y);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomAt(view.scale * 1.4, 0, 0);
    if (e.key === "-") zoomAt(view.scale / 1.4, 0, 0);
    if (e.key === "0") setView({ scale: 1, x: 0, y: 0 });
    if (many && e.key === "ArrowRight") step(1);
    if (many && e.key === "ArrowLeft") step(-1);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="full" motionPreset="none">
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.900" />
        <Dialog.Positioner>
          <Dialog.Content bg="transparent" shadow="none" onKeyDown={onKey} aria-label={alt ?? "Фото"}>
            <Box ref={box} position="fixed" inset="0" overflow="hidden" touchAction="none" userSelect="none"
                 cursor={view.scale > 1 ? "grab" : "zoom-in"}
                 onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
                 onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDouble}>
              {current && (
                <Image src={current} alt={alt ?? "Фото"} draggable={false} position="absolute" top="50%" left="50%"
                       maxW="100vw" maxH="100dvh" objectFit="contain"
                       style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                         transition: pointers.current.size ? "none" : "transform .12s ease-out" }} />
              )}
            </Box>
            <HStack position="fixed" top="3" right="3" gap="1" bg="blackAlpha.700" rounded="full" p="1" zIndex="1">
              <IconButton aria-label="Отдалить" size="sm" variant="ghost" color="white" rounded="full"
                          onClick={() => zoomAt(view.scale / 1.4, 0, 0)}><LuMinus /></IconButton>
              <Text color="white" textStyle="xs" minW="10" textAlign="center" fontVariantNumeric="tabular-nums">
                {Math.round(view.scale * 100)}%
              </Text>
              <IconButton aria-label="Приблизить" size="sm" variant="ghost" color="white" rounded="full"
                          onClick={() => zoomAt(view.scale * 1.4, 0, 0)}><LuPlus /></IconButton>
              <IconButton aria-label="По размеру экрана" size="sm" variant="ghost" color="white" rounded="full"
                          onClick={() => setView({ scale: 1, x: 0, y: 0 })}><LuMaximize /></IconButton>
              <IconButton aria-label="Закрыть" size="sm" variant="ghost" color="white" rounded="full" onClick={onClose}><LuX /></IconButton>
            </HStack>
            {many && (
              <>
                <IconButton aria-label="Предыдущее фото" position="fixed" left="3" top="50%" transform="translateY(-50%)"
                            size="lg" rounded="full" bg="blackAlpha.700" color="white" _hover={{ bg: "blackAlpha.800" }}
                            onClick={() => step(-1)}><LuChevronLeft /></IconButton>
                <IconButton aria-label="Следующее фото" position="fixed" right="3" top="50%" transform="translateY(-50%)"
                            size="lg" rounded="full" bg="blackAlpha.700" color="white" _hover={{ bg: "blackAlpha.800" }}
                            onClick={() => step(1)}><LuChevronRight /></IconButton>
                <Text position="fixed" top="4" left="50%" transform="translateX(-50%)" color="white" textStyle="sm"
                      bg="blackAlpha.700" px="3" py="1" rounded="full" fontVariantNumeric="tabular-nums">
                  {idx + 1} / {list.length}
                </Text>
              </>
            )}
            <Text position="fixed" bottom="4" left="50%" transform="translateX(-50%)" color="whiteAlpha.800" textStyle="xs"
                  bg="blackAlpha.600" px="3" py="1" rounded="full" whiteSpace="nowrap" pointerEvents="none" hideBelow="sm">
              Колесо или два пальца — приблизить · двойное касание — 2,5×{many ? " · ← → или свайп — листать" : ""} · Esc — закрыть
            </Text>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Миниатюра фото: по нажатию — просмотр на весь экран с приближением. Если передан весь список {@code srcs},
 * просмотр открывается на этом фото и листается дальше.
 */
export function PhotoThumb({ src, srcs, index = 0, alt, size = "20", more = 0 }: {
  src: string; srcs?: string[]; index?: number; alt?: string; size?: string; more?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <chakra.button type="button" position="relative" w={size} h={size} rounded="md" overflow="hidden" flexShrink={0}
           borderWidth="1px" cursor="zoom-in" onClick={(e) => { e.stopPropagation(); setOpen(true); }}
           aria-label={`Открыть фото${alt ? `: ${alt}` : ""}${more ? ` и ещё ${more}` : ""}`}
           _hover={{ "& .zoom": { opacity: 1 } }}>
        <Image src={src} alt={alt ?? "Фото"} w="full" h="full" objectFit="cover" />
        {more > 0 ? (
          <Box position="absolute" inset="0" display="grid" placeItems="center" bg="blackAlpha.600" color="white"
               fontWeight="semibold" textStyle="sm">+{more}</Box>
        ) : (
          <Box className="zoom" position="absolute" inset="0" display="grid" placeItems="center" bg="blackAlpha.500"
               color="white" opacity="0" transition="opacity .15s"><LuZoomIn /></Box>
        )}
      </chakra.button>
      <PhotoViewer srcs={srcs ?? [src]} start={srcs ? index : 0} alt={alt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * Несколько фото рядом: первые {@code max} миниатюр, на последней — «+N». Любая открывает просмотр всех
 * с листанием.
 */
export function PhotoStrip({ srcs, alt, size = "16", max = 3 }: { srcs: string[]; alt?: string; size?: string; max?: number }) {
  if (!srcs.length) return null;
  const shown = srcs.slice(0, max);
  return (
    <HStack gap="1.5" flexShrink={0} align="start">
      {shown.map((s, i) => (
        <PhotoThumb key={s} src={s} srcs={srcs} index={i} alt={alt} size={size}
                    more={i === shown.length - 1 ? srcs.length - shown.length : 0} />
      ))}
    </HStack>
  );
}
