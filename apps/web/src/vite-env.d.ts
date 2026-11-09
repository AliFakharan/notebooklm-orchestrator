/// <reference types="vite/client" />

/**
 * Backend origin in dev (injected by vite.config.ts, same source as the
 * /api proxy target). Empty string in production builds: the backend serves
 * the SPA from the same origin, so links stay relative.
 */
declare const __NLO_BACKEND_URL__: string;
