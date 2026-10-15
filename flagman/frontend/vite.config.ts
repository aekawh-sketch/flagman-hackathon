import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// В разработке API проксируется на Spring Boot — один источник, cookie сессии работают как в проде.
// API_TARGET — другой экземпляр бэкенда (например, на копии базы для проверок).
declare const process: { env: Record<string, string | undefined> };   // без @types/node ради одной строки
const target = process.env.API_TARGET ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/public": { target, changeOrigin: false },
      "/swagger-ui": { target },
      "/docs": { target },
      "/v3/api-docs": { target },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
});
