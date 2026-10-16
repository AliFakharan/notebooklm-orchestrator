# معماری — NotebookLM Orchestrator

> وضعیت: فاز 0 (تأمین) — تصمیمات پیش‌فرض و قابل بازگشت. هر تصمیم مهم در انتهای بخش مربوطه علامت‌گذاری شده است.

## ۱. هدف و دامنه

یک اپلیکیشن **محلی، تک‌کاربری، وب** برای:

- ثبت درخواست «صوت + دستور (prompt)» و پردازش آن از طریق یک provider سازگار با NotebookLM
- انتخاب (خودکار یا دستی) حساب گوگل واجد شرایط
- انتخاب (خودکار یا دستی) نود VLESS سالم
- اجرای **نوبتی (asynchronous)** کارها با وضعیت، پیشرفت، لاگ و تاریخچه تلاش‌ها
- آرشیو هر درخواست (ورودی، snapshot پیکربندی، timeline، خروجی‌ها، خطاها)
- مدیریت چند حساب گوگل و چند نود VLESS
- **fail-closed**: در نبود مسیر پروکسیِ تأییدشده، ترافیک provider به‌هیچ‌وجه مستقیم خارج نمی‌شود

**غیرهدف (مراحل بعدی):** VPS، دامنه، Cloudflare Tunnel، دسترسی عمومی، دیتابیس غیر-SQLite، چندهسته‌ای/کلادرای توزیع‌شده.

## ۲. نمای کلی معماری

```
┌───────────────────────────────  اپلیکیشن (loopback only)  ───────────────────────────────┐
│                                                                                          │
│  ┌────────────┐        ┌──────────────────────────── apps/server (Fastify) ─────────┐    │
│  │  apps/web   │ HTTP   │                                                            │    │
│  │ React+TS    │───────▶│  API routes (zod validation, rate limit, loopback bind)    │    │
│  │ (Vite, RTL) │        │        │                                                   │    │
│  └────────────┘         │        ▼                                                   │    │
│                         │  domain/   jobs • accounts • proxies • queue • archive     │    │
│                         │        │        │                │                          │    │
│                         │        ▼        ▼                ▼                          │    │
│                         │  node:sqlite (migrations)      data/jobs/<id>/archive      │    │
│                         │        │                                                   │    │
│                         │        ▼                                                   │    │
│                         │  providers/  NotebookLMProvider (interface)                │    │
│                         │     ├── MockProvider (default, deterministic)               │    │
│                         │     └── PythonWorkerProvider (disabled by default)          │    │
│                         │        │  spawn python3 worker (JSON-line protocol,         │    │
│                         │        │  0600 request file, no shell, no argv secrets)     │    │
│                         │        ▼                                                   │    │
│                         │  proxy/  EgressGuard ──▶ local listener (SOCKS5/HTTP)       │    │
│                         └────────┼───────────────────────────────────────────────────┘    │
└──────────────────────────────────┼─────────────────────────────────────────────────────────┘
                                   ▼  (تنها ترافیک مجاز از worker)
                    ProxyRuntime adapter (Xray)  ──▶  VLESS node  ──▶  NotebookLM
```

## ۳. کامپوننت‌ها

| کامپوننت         | فناوری                                      | توضیح                                                                                                                          |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web`       | React 19 + TypeScript + Vite + Tailwind v4  | UI فارسی RTL، فونت Vazirmatn (باندل‌شده محلی). به هیچ‌وجه مستقیم به گوگل/NotebookLM/VLESS وصل نمی‌شود؛ همه‌چیز از طریق `/api`. |
| `apps/server`    | Node 24 + Fastify 5 + TypeScript            | API + worker درپروس + vault + queue.                                                                                           |
| Durable queue    | جدول SQLite + حلقه‌ی worker درپروس          | بدون سرور queue جدا. بعد از restart، jobهای غیرتسخت‌شده به `QUEUED` برمی‌گردند.                                                |
| Databases        | `node:sqlite` (built-in، بدون وابستگی بومی) | مایگریشن‌های numbered SQL در `apps/server/src/db/migrations/`.                                                                 |
| Provider adapter | interface تایپ‌شده + Mock + worker پایتون   | جزئیات در `provider-evaluation.md`.                                                                                            |
| Proxy runtime    | interface + Mock + Xray (stub)              | جزئیات در `proxy-design.md`.                                                                                                   |
| Secrets          | vault فایل-محور AES-256-GCM                 | جزئیات در `security.md`.                                                                                                       |

## ۴. state machine کار (Job)

وضعیت‌ها: `CREATED → VALIDATING → QUEUED → WAITING_FOR_ACCOUNT → WAITING_FOR_PROXY → RUNNING → (RETRY_WAIT) → SUCCEEDED | FAILED | NEEDS_ATTENTION | CANCEL_REQUESTED → CANCELLED`

قوانین گذار قانونی **تمرکز** در `packages/shared/src/job-state.ts` (تست‌شده):

- فقط وضعیت‌های terminal: `SUCCEEDED`, `FAILED`, `CANCELLED`
- `CANCEL_REQUESTED` فقط از `RUNNING`/`RETRY_WAIT`/`WAITING_*`؛ سپس `→ CANCELLED`
- `NEEDS_ATTENTION` (نتیجه‌ی مبهم) فقط با عمل کاربر: `→ QUEUED` (بازآموزی) یا `→ CANCELLED`
- `RETRY_WAIT → WAITING_FOR_ACCOUNT` (تلاش جدید) یا `→ FAILED` (تعادل retry تمام شد)
- هر گذار نامعتبر در سطح دامنه خطا می‌دهد؛ تست واحد دارد.

**خطای مبهم (ambiguous completion):** اگر worker قطع شود و نتایج provider ناشناخته باشد (مثلاً پاسخ ممکن است رسیده باشد)، job به `NEEDS_ATTENTION` می‌رود؛ retry کور انجام نمی‌شود.

## ۵. مدل داده (SQLite)

- `accounts` — label، email نمایشی، status (`ACTIVE|DEGRADED|RATE_LIMITED|AUTH_REQUIRED|DISABLED|UNKNOWN`)، enabled، last_success_at، last_error
- `proxy_nodes` — name، server، port، uuid (فقط به‌صورت reference به vault)، transport، security، sni، ws_host، ws_path، extra_json (پارامترهای ناشناخته حفظ می‌شوند)، enabled، priority
- `proxy_health` + `proxy_health_history` — last check، egress IP، latency، error
- `jobs` — id server-side (`j_<hex32>`)، input_json (prompt + meta صوت + preferها)، status، attempt، account/proxy انتخاب‌شده، progress، error/result json
- `job_events` (timeline، jsonl در آرشیو هم mirror می‌شود)، `job_attempts`
- `artifacts` — id، job، filename ایمن، media_type، size، source (`provider|application`)، storage_key
- `secrets` — vault records
- `settings` — key/value
- `schema_migrations`

## ۶. آرشیو درخواست

```
data/jobs/<job-id>/
  manifest.json          # snapshot کامل پیکربندی + ورودی + hash فایل‌ها
  input/prompt.md
  input/original-audio   # نام اصلی در manifest، نام فایل روی disk ایمن‌شده
  execution/timeline.jsonl
  execution/attempts.json
  execution/errors.json
  output/answer.md
  output/artifacts/<n>-<safe-name>
```

- job id **server-generated** است؛ هیچ‌گاه نام فایل کاربر به‌عنوان مسیر استفاده نمی‌شود.
- `data/` خارج از Git (`.gitignore`).

## ۷. تصمیمات کلیدی و دلیل (preference ≠ requirement)

| تصمیم                                             | گزینه‌های دیگر             | دلیل                                                                                                                                   |
| ------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| monorepo با npm workspaces (`apps/`, `packages/`) | دو repo جدا                | یک lockfile، یک TS config، type-sharing بین web/server                                                                                 |
| Fastify 5                                         | Hono، Express              | typed، plugin رسمی multipart/rate-limit/static، graceful shutdown                                                                      |
| `node:sqlite` (built-in)                          | better-sqlite3، PostgreSQL | بدون وابستگی بومی و بدون build؛ برای تک‌کاربر محلی کافی است. (تصمیم قابل بازگشت — لایه‌ی repository جداست)                             |
| Queue درپروس DB-backed                            | Redis، BullMQ              | الزام «بدون زیرساخت جدا»؛ persistence با restart test شده                                                                              |
| React + Vite + Tailwind v4                        | Next.js                    | «بدون SSR/ISR لازم»؛ ساده و سریع برای اپ محلی                                                                                          |
| provider = worker پایتون جدا (narrow protocol)    | port کامل کتابخانه به TS   | notebooklm-py مرجع قوی‌تر است؛ port ریسک drift بالایی دارد. (تصمیم قابل بازگشت — با interface `NotebookLMProvider` کپسوله شده)         |
| Xray به‌عنوان runtime VLESS (فقط stub فعلاً)      | mihomo، پیاده‌سازی اختصاصی | maintained، binary رسمی linux-x64، بدون install سیستمی (در `data/vendor/`). نصب واقعی **نیازمند تأیید**                                |
| vault فایل AES-256-GCM                            | OS keyring                 | در محیط فعلی keyring گویا موجود نیست؛ key file 0600 + key از env. مودل تهدید در `security.md`. (قابل بازگشت — `SecretStore` interface) |

## ۸. ساختار دایرکتوری

```
notebooklm-orchestrator/
├── apps/server/      # API + domain + queue + provider/proxy adapters
├── apps/web/         # React RTL app
├── packages/shared/  # types + state machine + validation schemas (zod)
├── data/             # runtime (SQLite، آرشیو، vault) — خارج از Git
├── docs/
└── research/         # (خارج از این repo — فقط مرجع)
```

## ۹. فرضیات و ناشناخته‌ها (Phase 0)

| #   | مورد                                                                                 | وضعیت                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | `research/notebooklm-mcp-roomi/` در workspace **موجود نیست** (در پرامپت ذکر شده بود) | ارزیابی آن انجام نشده؛ در صورت درخواست، clone می‌شود                                                                                                                  |
| U2  | پشتیبانی mp3 به‌عنوان منبع صوتی در notebooklm-py                                     | فقط مسیر `.wav` مستند/تست‌شده است (issue #2138)؛ mp3 = «تأییدنشده»                                                                                                    |
| U3  | رفتار proxy در clientهای داخلی httpx notebooklm-py                                   | بعضی ساخت‌ها `trust_env` پیش‌فرض (True) دارند؛ بعضی (source-fetch) `trust_env=False`. در worker، env proxy به‌صراحت تنظیم + egress verification پیش از فعال‌سازی live |
| U4  | موجود بودن keyring OS در این سیستم                                                   | بررسی نهایی نشد؛ vault فایل-محور انتخاب شد                                                                                                                            |
| U5  | نصب Xray                                                                             | **انجام نشده** (نیازمند تأیید). فعلاً mock runtime                                                                                                                    |
