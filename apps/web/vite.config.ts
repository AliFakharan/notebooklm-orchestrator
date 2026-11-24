import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Dev: proxy /api to the loopback Fastify backend so the browser can call the
// API same-origin (matching production, where main.ts serves apps/web/dist).
const backend = process.env.NLO_DEV_BACKEND ?? "http://127.0.0.1:4870";

// NLO_INLINE_ASSETS=1: single-request resilience build. Some national
// middleboxes (Iran → Germany path) reset CSS/font fetches while JS passes.
// This inlines the built CSS (with woff2 data-URIs) into index.html so the
// page ships as HTML + JS only. JS stays external (it demonstrably loads).
const inlineAssets = process.env.NLO_INLINE_ASSETS === "1";
const distDir = fileURLToPath(new URL("./dist", import.meta.url));

const inlineCssPlugin = {
  name: "nlo-inline-css",
  apply: "build" as const,
  writeBundle() {
    const htmlPath = path.join(distDir, "index.html");
    const html = readFileSync(htmlPath, "utf8").replace(
      /<link\s+rel="stylesheet"[^>]*>/g,
      (tag) => {
        const href = tag.match(/href="([^"]+)"/)?.[1];
        if (!href) return tag;
        const cssPath = path.join(distDir, href.replace(/^\//, ""));
        if (!existsSync(cssPath)) return tag;
        return `<style>${readFileSync(cssPath, "utf8")}</style>`;
      },
    );
    writeFileSync(htmlPath, html);
  },
};

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), ...(inlineAssets ? [inlineCssPlugin] : [])],
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
    // woff2 only: each @font-face lists woff2 first, so modern browsers never
    // fetch the woff fallback that stays external.
    ...(inlineAssets
      ? { assetsInlineLimit: (f: string) => f.endsWith(".woff2") }
      : {}),
  },
}));
