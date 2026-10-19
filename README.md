# NotebookLM Orchestrator

اپلیکیشن **محلی** (تک‌کاربر، loopback) برای مدیریت درخواست‌های «صوت + دستور» به NotebookLM،
مدیریت حساب‌های گوگل و نودهای VLESS، اجرای نوبتی کارها، آرشیو و نمایش فارسی RTL.

- شروع سریع (نصب + mock + حالت زنده + Docker): [`docs/quick-start.md`](docs/quick-start.md)
- مستندات: [`docs/architecture.md`](docs/architecture.md)، [`docs/security.md`](docs/security.md)،
  [`docs/provider-evaluation.md`](docs/provider-evaluation.md)، [`docs/proxy-design.md`](docs/proxy-design.md)،
  [`docs/development-plan.md`](docs/development-plan.md)
- مخازن مرجع (فقط مرجع، اجرا نمی‌شوند): `../research/`

## اجرا

**ساده‌ترین راه (Docker):**

```bash
docker compose up --build -d     # UI روی http://127.0.0.1:4870
```

**بدون Docker:**

```bash
npm install
npm run build
npm run start --workspace @nlo/server   # UI + API روی http://127.0.0.1:4870
```

server همان `apps/web/dist` را با SPA fallback سرو می‌کند (یک پورت برای همه:
API + وب). مسیرهای /api در 404، envelope JSON نگه می‌مانند.
حالت پیش‌فرض **mock** است؛ حالت زنده (حساب گوگل واقعی + پراکسی Xray) در بخش
زیر و در [`docs/quick-start.md`](docs/quick-start.md) توضیح داده شده.

## اجرا (توسعه)

```bash
npm run dev          # server روی 127.0.0.1:4870 + web روی 127.0.0.1:5173 (proxy /api به server)
```

## دستورات

```bash
npm test             # تست‌ها (بدون شبکه، بدون Google، بدون credential واقعی)
npm run typecheck    # بررسی تایپ همه‌ی workspaces
npm run lint         # eslint
npm run format:check # prettier
npm run build        # build وب + typecheck سرور
```

## ایمنی — خلاصه‌ی خط‌مشی

- binding پیش‌فرض **loopback**؛ هیچ دسترسی عمومی.
- ترافیک provider **fail-closed**: بدون پروکسیِ تأییدشده، direct egress نمی‌شود (تست‌شده با mock transport).
- secretها در vault با **AES-256-GCM**؛ UUID VLESS masked؛ logها redact.
- پیش‌فرض **mock** است؛ حالت زنده فقط با انتخاب صریح (`NLO_PROVIDER=python-worker` +
  `NLO_PROXY_RUNTIME=xray`) روشن می‌شود.
- جزئیات: [`docs/security.md`](docs/security.md)

## حالت زنده (live mode) — ورود واقعی + پراکسی واقعی + شغل واقعی

سیستم پیش‌فرض mock اجرا می‌شود و همه‌ی خروجی‌هایش با برچسب mock نمایش داده می‌شوند.
برای اجرای **واقعی** (درخواست به NotebookLM واقعی از طریق پروکسی واقعی):

```bash
# ۱) آماده‌سازی کارگر پایتونی (یک‌بار) — venv جدا از سیستم
npm run worker:setup --workspace @nlo/server
#    → data/venv با notebooklm-py + playwright chromium

# ۲) پیکربندی
cp .env.example .env
#    NLO_PROVIDER=python-worker
#    NLO_PROXY_RUNTIME=xray
#    NLO_PYTHON_BIN=$PWD/data/venv/bin/python

# ۳) باینری Xray (یک‌بار) — در data/vendor/xray/xray
#    (خروجی رسمی xray؛ بدون آن، runtime «not_configured» گزارش می‌دهد)

# ۴) راه‌اندازی
npm run dev

# ۵) در UI: یک حساب بسازید ← «دریافت از مرورگر واقعی» (کوکی‌های نشست گوگل
#    از مرورگر خودت روی همین دستگاه خوانده و verify می‌شود) یا «ورود پیشرفته
#    (storage-state)» برای آپلود storage-state JSON
#    یک نود VLESS بسازید ← «سلامت (امتحان خروج)» و «سلامت (مقصد NotebookLM)»

# ۶) اعتبارسنجی زنده (manual gate؛ هرگز در CI اجرا نمی‌شود)
npm run verify:live --workspace @nlo/server
```

**صادقانه بودن نتیجه:** هر شغل `resultProvenance` دارد — `real` فقط وقتی خود
provider گزارش کند که خروجی واقعی است؛ `mock` برای شبیه‌ساز؛ در غیر این صورت
`unknown`. صفحه‌ی جزئیات شغل این برچسب را کنار «پاسخ» نشان می‌دهد و هیچ‌جای UI
ادعای «زنده» بدون این مدرک نمی‌کند.

محدودیت‌های شناخته‌شده و وضعیت دقیق پیاده‌سازی:
[`docs/provider-evaluation.md`](docs/provider-evaluation.md) (بخش ۵).
