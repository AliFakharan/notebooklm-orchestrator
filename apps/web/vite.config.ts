import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Dev: proxy /api to the loopback Fastify backend so the browser can call the
// API same-origin (matching production, where main.ts serves apps/web/dist).
const backend = process.env.NLO_DEV_BACKEND ?? "http://127.0.0.1:4870";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    // Dev: expose the backend origin (same source as the /api proxy) so the
    // API docs link reaches the backend. Production builds stay relative —
    // the backend serves the SPA from the same origin.
    __NLO_BACKEND_URL__: command === "serve" ? JSON.stringify(backend) : JSON.stringify(""),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
}));
