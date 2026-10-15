import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

/** Цвета статусов (ТЗ 7): свежая — зелёный, скоро — жёлтый, критично — оранжевый, просрочка и стоп — красный. */
const config = defineConfig({
  globalCss: {
    "html, body": { bg: "bg.subtle" },
    "*:focus-visible": { outlineColor: "teal.500" },
    // Графики: поле графика фокусируемое (стрелки двигают подсказку), но рамка вокруг всего графика
    // после клика выглядит как сбой — фокус и так виден по подсказке и выделенному столбику.
    ".recharts-wrapper, .recharts-wrapper *": { outline: "none !important", WebkitTapHighlightColor: "transparent" },
  },
  theme: {
    tokens: {
      fonts: {
        body: { value: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
        heading: { value: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
        mono: { value: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace" },
      },
    },
    semanticTokens: {
      colors: {
        brand: {
          solid: { value: { _light: "{colors.teal.600}", _dark: "{colors.teal.400}" } },
          fg: { value: { _light: "{colors.teal.700}", _dark: "{colors.teal.300}" } },
          muted: { value: { _light: "{colors.teal.50}", _dark: "{colors.teal.950}" } },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
