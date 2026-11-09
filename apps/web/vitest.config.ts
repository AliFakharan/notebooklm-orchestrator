import type { UserConfig, UserConfigFn } from "vite";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// vite.config.ts may export a config function (command-based `define`);
// mergeConfig only accepts plain objects, so resolve the function form here.
const base = (
  typeof viteConfig === "function"
    ? (viteConfig as UserConfigFn)({ command: "serve", mode: "test" })
    : viteConfig
) as UserConfig;

export default mergeConfig(
  base,
  defineConfig({
    define: { __NLO_BACKEND_URL__: JSON.stringify("") },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
);
