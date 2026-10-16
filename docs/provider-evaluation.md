# ارزیابی providerها — NotebookLM

## ۱. خلاصه‌ی مقایسه (بر اساس source واقعی checkout‌شده، نه گزارش شایعه‌وار)

| معیار                | notebooklm-py (teng-lin)                                                                                                               | notebooklm-mcp (PleasePrompto)                                                | notebooklm-mcp (roomi)                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| موجود در `research/` | بله، `v0.8.5-8-gfd7af2cd`                                                                                                              | بله، `v2.0.0-1` — **archive شده (سپتامبر 2026)**                              | **خیر — در workspace موجود نیست** (ناشناخته U1) |
| زبان / مدل           | Python ≥3.10، کتابخانه‌ی async + CLI + MCP + REST                                                                                      | TypeScript، MCP server، **browser automation** (Patchright)                   | —                                               |
| روش دسترسی به سرویس  | **مستقیم** با endpointهای undocumented گوگل: web `batchexecute` (httpx)، Android gRPC (opt-in)، curl_cffi (opt-in)                     | **scrape از UI** در Chrome واقعی (DOM selectors)                              | —                                               |
| احراز هویت           | cookie از browser (Playwright)، import cookie، **master-token headless** (gpsoauth)، bearer برای Android؛ profileها در `~/.notebooklm` | login تعاملی در Chrome؛ cookie در Chrome profile؛ auto-login با env (ضعیف‌تر) | —                                               |
| تست                  | گسترده: unit + integration (VCR cassettes) + e2e opt-in + fault-injection harness                                                      | **هیچ** (`npm test` فقط server را راه می‌اندازد)                              | —                                               |
| پشتیبانی proxy       | client httpx injectable؛ بعضی clientها `trust_env=True` (env proxy)، بعضی `trust_env=False`                                            | ندارد                                                                         | —                                               |
| لایسنس               | MIT                                                                                                                                    | MIT                                                                           | —                                               |
| ریسک اصلی            | endpointهای خصوصی ممکن است تغییر کنند                                                                                                  | به UI وابسته، archive شده، untested                                           | —                                               |

## ۲. notebooklm-py — یافته‌های source-verified

- **ورودی‌ها:** `notebooklm` (Click CLI)، `notebooklm-mcp` (FastMCP)، `notebooklm-server` (FastAPI) — همه از یک هسته‌ی `_app/` (feature services) روی بکند `_web/` یا `_android/`.
- **auth:** فایل‌های `storage_state.json` per-profile در `NOTEBOOKLM_HOME` (default `~/.notebooklm`)؛ ماژول `_auth/` شامل ۳۵+ ماژول (keepalive، recovery ladder، storage lock). **پسورد گوگل در UI خواسته نمی‌شود**؛ ورود از طریق browser cookie یا master token.
- **آپلود صوت:** مسیر مستند و تست‌شده برای **`.wav`** (issue #2138 در source: «WAV uploads cleanly»). `mp3/m4a` **تأییدنشده** — در UI ما به‌عنوان «تأییدنشده در provider» نشان داده می‌شود (U2).
- **chat/ask:** `ask` روی notebook با sourceهای موجود — این دقیقاً الگوی «صوت را به‌عنوان source اضافه کن + prompt بپرس» است که ما می‌خواهیم.
- **proxy nuance (U3):** `source_fetch` با `trust_env=False` ساخته می‌شود؛ اما clientهای داخلی دیگر (مثل `mint_service`) `trust_env` پیش‌فرض دارند → env-proxy روی همه‌ی مسیرها یکسان اثر نمی‌کند. **نتیجه:** worker ما env proxy را تنظیم می‌کند **و** پیش از فعال‌سازی live، egress verification واقعی (egress IP) الزامی است.
- **quota:** عدد ثابت ۵۰/روز در reference ذکر شده، اما در source به‌عنوان guarantee نیست → ما **quota عددی ثابت نمی‌سازیم**؛ فقط وضعیت از provider می‌گیریم.

## ۳. انتخاب: `PythonWorkerProvider` روی notebooklm-py + `MockProvider` پیش‌فرض

**چرا worker جدا به‌جای port به TS؟** کتابخانه ~۱۰۰k سطر، وابسته به endpointهای خصوصی و ADRهای متعدد؛ port ریسک drift و cost بالایی دارد. adapter ما **باریک** است:

```
apps/server/src/providers/
  types.ts              # NotebookLMProvider interface (typed)
  registry.ts           # انتخاب provider از config
  mock-provider.ts      # پیش‌فرض؛ قطعی؛ برای test و demo
  python-worker/
    protocol.ts         # JSON-line protocol (zod-validated)
    worker.ts           # spawn/timeout/kill، فایل request 0600، بدون shell
    nbl_worker.py       # اسکریپت پایتون باریک (import از notebooklm-py اگر موجود باشد)
```

**نقش توانایی‌ها (capability matrix) — صادقانه:**

| عمل                                          | Mock                            | PythonWorker (live)                                                                                               |
| -------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `validateConfiguration`                      | ✅ تست‌شده                      | ⚠️ پیاده‌سازی، **بدون تست live**                                                                                  |
| `getAccountStatus`                           | ✅                              | ⚠️ (از probe حساب کتابخانه)                                                                                       |
| `listNotebooks` / `createOrSelectNotebook`   | ✅                              | ⚠️                                                                                                                |
| `submitAudioJob` (upload صوت + prompt)       | ✅                              | ⚠️ (فقط مسیر `.wav` مستند؛ mp3 تأییدنشده)                                                                         |
| `getJobStatus` / `retrieveResult` (Markdown) | ✅                              | ⚠️                                                                                                                |
| `retrieveArtifacts`                          | ✅ (artifact ساختگی mock، مشخص) | ⚠️ (فقط آنچه provider واقعاً برگرداند)                                                                            |
| `cancelJob`                                  | ✅                              | ❌ **پشتیبانی واقعی وجود ندارد** — اگر کار در حال انجام است، cancel فقط «request» است و محدودیت در UI بیان می‌شود |

**قانون:** هیچ قابلیت fake در UI واقعی نمایش داده نمی‌شود؛ mock فقط در demo-mode روشن و با برچسب.

## ۴. خطرات و کنترل‌ها

| خطر                            | کنترل                                                                     |
| ------------------------------ | ------------------------------------------------------------------------- |
| تغییر endpointهای خصوصی گوگل   | provider کپسوله؛ خطا به‌صورت ساختاریافته؛ live-off by default             |
| مصرف cookie/توکن در log        | redaction layer + test                                                    |
| subprocess ناسالم              | spawn بدون shell، timeout، kill group، validate I/O                       |
| duplicate side-effect در retry | retry فقط برای خطاهای retryable-classified؛ ambiguous → `NEEDS_ATTENTION` |
| account rate-limit             | دسته‌بندی خطا + backoff + account rotation فقط اگر مجاز و بی‌خطر          |

## ۵. وضعیت پیاده‌سازی (به‌روزرسانی — پس از فاز live)

**آنچه واقعاً پیاده شده و قابل‌اجراست:**

| لایه                                           | وضعیت واقعی (بدون ادعای «تست‌شده زنده» تا انجام واقعی)                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PythonWorkerProvider` + supervisor + protocol | پیاده‌سازی‌شده؛ spawn بدون shell، timeout/kill، فایل request با ۰۶۰۰، پروتکل JSON-line با zod. **تست زنده انجام نشده** (نیازمند venv + ورود واقعی)         |
| ورود واقعی (login)                             | پیاده‌سازی‌شده با Playwright (تعاملی، پنجره مرورگر) + import storage-state + verify در برابر سرویس واقعی؛ session در جدول `auth_sessions` با state machine |
| runtime خارجی (`NLO_PROXY_RUNTIME=xray`)       | پیاده‌سازی‌شده: تونل واقعی VLESS (loopback CONNECT inbound)، fetch واقعی TLS از درون تونل، بررسی مرحله‌ای سلامت با evidence + category                     |
| انتخاب شفاف نود/حساب + fail-closed             | پیاده‌سازی‌شده و **تست‌شده** (scenarios ۱–۱۱؛ هیچ fallback پنهانی به egress مستقیم نیست)                                                                   |
| provenance نتیجه                               | هر job `resultProvenance` دارد (`real` / `mock` / `unknown`) — از گزارش خود provider خوانده می‌شود، نه فرض                                                 |

**درگاه‌های اعتبارسنجی زنده (manual gate — هرگز در CI اجرا نمی‌شوند):**

```
npm run worker:setup --workspace @nlo/server    # data/venv + notebooklm-py + playwright chromium
npm run verify:live  --workspace @nlo/server    # preflight → login/verify → real tunnel egress → manual job
```

خروجی `verify:live` شواهد چاپ‌شده می‌دهد (egress IP واقعی مشاهده‌شده از طریق تونل، email حساب تأییدشده،
نکات دستی برای job زنده). تا این harness پاس نشود، هر خروجی live در UI با provenance `unknown` نمایش
داده می‌شود — یعنی **سیستم خودش «زنده‌بودن» را ادعا نمی‌کند**.

**محدودیت‌های باقی‌مانده (صادقانه):**

- `cancelJob` در notebooklm-py هنوز پشتیبانی واقعی ندارد (فقط request؛ شغل ممکن است در provider ادامه یابد).
- مسیر آپلود `.wav` مستند است؛ `mp3/m4a` هنوز تأییدنشده در provider.
- `trust_env` در notebooklm-py یکسان روی همه clientها اثر نمی‌کند (U3)؛ به همین دلیل env-proxy worker
  مکمل egress-verification است و جایگزین آن نمی‌شود.
