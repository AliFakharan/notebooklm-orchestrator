# برنامه‌ی توسعه — NotebookLM Orchestrator

## محیط (verify شده در 2026-10-15)

| مورد          | وضعیت                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| Node          | v24.19.0 (npm 11.17.0)                                                                        |
| Python        | 3.12.3 (`pip3`/`uv` **ندارند**)                                                               |
| SQLite        | `node:sqlite` built-in **verify شده**؛ CLI `sqlite3` ندارد                                    |
| ffmpeg / xray | **نصب نیستند** (نصب بدون تأیید انجام نمی‌شود)                                                 |
| Git repo      | scaffold خالی، branch `main`، remote `git@github.com:AliFakharan/notebooklm-orchestrator.git` |

## فازها و وضعیت

### فاز 0 — Audit ✅

- بررسی repo (خالی)، referenceها (manifests، entry، auth، network، tests، license)
- شناسایی وابستگی‌های ریسک‌دار: Playwright (پایتون، extra `browser`)، Patchright (TS) — **هیچ‌کدام در اپ ما اجرا نمی‌شود**؛ فقط reference
- فایل‌های credential واقعی در workspace: **ندارد** (فشار کد/تست reference)
- docs: architecture / security / provider-evaluation / proxy-design / این فایل
- ناشناخته‌ها: U1–U5 در `architecture.md` §۹

### فاز 1 — Foundation ✅ (در حال پیاده‌سازی)

- monorepo npm workspaces؛ TS strict؛ ESLint+Prettier+Vitest
- SQLite + مایگریشن؛ API typed با فرمت خطای یکنواخت؛ config ایمن (env، بدون secret در نمونه)
- shell فارسی RTL (Vazirmatn، design tokens)

### فاز 2 — Core domain

- models + state machine + queue + archive + تست

### فاز 3 — Admin UI

- dashboard، history، job detail، accounts، proxies، providers، settings

### فاز 4 — Provider adapter

- interface + MockProvider (active) + PythonWorker (disabled by default، protocol + tests)
- live auth **غیرفعال** تا تأیید

### فاز 5 — Proxy runtime

- URI parser + masking + MockProxyRuntime + testهای fail-closed
- Xray **غیرفعال** تا تأیید

### فاز 6 — عینک محلی

- lint/types/test کامل؛ loopback verify؛ secret-leak check؛ no-direct-egress check

## اعلان‌های ایمنی (هرگز بدون تأیید)

- نصب سیستمی (ffmpeg، xray سیستمی، VPN)
- تغییر routing/DNS/firewall
- احراز هویت واقعی گوگل / اجرای job واقعی NotebookLM
- push به remote
- binding غیر-loopback

## دستورات

```
npm run dev        # server + web (dev)
npm test           # vitest (بدون نیاز به شبکه/Google)
npm run lint / typecheck / format
npm run build      # تولید web + server dist
```

تست‌های live: opt-in (`NLO_LIVE_TESTS=1` + credentials در خارج از repo) و **غیرفعال** در CI/عادی.
