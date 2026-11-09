# NotebookLM Orchestrator

اپلیکیشن وب (تک‌کاربر) برای مدیریت درخواست‌های «صوت + دستور» به NotebookLM،
مدیریت حساب‌های گوگل و نودهای VLESS، اجرای نوبتی کارها، آرشیو و نمایش فارسی RTL.

- شروع سریع (نصب + mock + حالت زنده + Docker): [`docs/quick-start.md`](docs/quick-start.md)
- مستندات: [`docs/architecture.md`](docs/architecture.md)، [`docs/security.md`](docs/security.md)،
  [`docs/provider-evaluation.md`](docs/provider-evaluation.md)، [`docs/proxy-design.md`](docs/proxy-design.md)،
  [`docs/development-plan.md`](docs/development-plan.md)
- مخازن مرجع (فقط مرجع، اجرا نمی‌شوند): `../research/`

## چطور کار می‌کند

1. **حساب گوگل**: با ایمیل ثبت می‌شود (ایمیل هویت حساب است و باید یکتا باشد).
   تنها مسیر ورود، **چسباندن کوکی‌های نشستِ گوگل** است: در مرورگر عادی خود وارد
   `notebooklm.google.com` می‌شوید، کوکی‌ها را با افزونه‌ی «کپی کوکی‌ها» کپی و در
   UI می‌چسبانید (storage-state JSON یا آرایه‌ی کوکی). هویت واقعی سپس **توسط
   سرویس گوگل** verify می‌شود و با ایمیل حساب مقایسه می‌گردد.
2. **پراکسی (VLESS)**: نودها با paste URI وارد می‌شوند (تک‌تکی یا دسته‌ای از
   کلیپ‌بورد) و با سلامت‌سنجی واقعی (خروج + مقصد NotebookLM) تأیید می‌شوند.
3. **درخواست (job)**: هر job **باید** یک حساب انتخاب کند (برچسب‌زنی «خودکار»
   وجود ندارد). رانر قبل از هر تلاش، اعتبار حساب (جلسه‌ی verify‌شده) و یک
   پراکسی سالم را بررسی می‌کند (fail-closed). درخواست‌های ناموفق را می‌توان
   با دکمه‌ی «بازتلاش» و همان حساب/اطلاعات دوباره در صف گذاشت (با انتخاب
   پراکسی تازه).
4. **نتیجه**: پاسخ + منبع (mock/real) + رویدادها + تلاش‌ها + فایل‌ها، همه در
   UI و آرشیو پایدار روی دیسک. فایل‌های ورودی پس از اتمام موفقیت‌آمیز
   به‌صورت خودکار حذف می‌شوند (رویداد «sources_cleaned» در timeline).

## اجرا

**در هر دو حالت، دو env اجباری** هستند: `NLO_ADMIN_USER` و `NLO_ADMIN_PASSWORD`
(ورود پنل `/admin` و قفل APIهای زیرساخت) — سرور بدون آن‌ها استارت را رد می‌کند.

**ساده‌ترین راه (Docker):**

```bash
# در .env کنار docker-compose.yml:
#   NLO_ADMIN_USER=…
#   NLO_ADMIN_PASSWORD=…      (compose بدون آن‌ها خطا می‌دهد)
docker compose up --build -d     # UI روی http://127.0.0.1:4870
```

**بدون Docker:**

```bash
npm install
npm run build
cp .env.example .env             # خطوط NLO_ADMIN_USER / NLO_ADMIN_PASSWORD را فعال و تکمیل کن
npm run start --workspace @nlo/server   # UI + API روی http://127.0.0.1:4870
```

server همان `apps/web/dist` را با SPA fallback سرو می‌کند (یک پورت برای همه:
API + وب). مسیرهای /api در 404، envelope JSON نگه می‌مانند.
حالت پیش‌فرض **mock** است؛ حالت زنده (حساب گوگل واقعی + پراکسی Xray) در بخش
زیر و در [`docs/quick-start.md`](docs/quick-start.md) توضیح داده شده.

### API و کلیدها

سطح job (`/api/jobs*`) API برنامه‌ای دارد؛ مهندسی کامل (OpenAPI) در
**`/documentation`** (Swagger UI). سه مسیر دسترسی: کلاینت‌های loopback بدون
اعتبارنامه؛ مرورگرها با cookie admin (ورود در `/admin`)؛ و کلاینت‌های
برنامه‌ای با **کلید API**:

1. در `/admin` ← «کلیدهای API» یک کلید بسازید — کلید (`nlo_…`) فقط یک‌بار
   نمایش داده می‌شود؛ آن را ذخیره کنید.
2. ساخت درخواست:

   ```bash
   curl -F "prompt=…" -F "sources=@doc.pdf" \
     -H "Authorization: Bearer nlo_…" http://127.0.0.1:4870/api/jobs
   ```

3. خواندن نتیجه: `GET /api/jobs/<id>` — متن پاسخ در `answerMarkdown` است.

جزئیات: [`docs/architecture.md`](docs/architecture.md) (بخش «دسترسی به API»).

### استقرار روی سرور

دقیقاً همان راه Docker توصیه می‌شود:

```bash
git clone git@github.com:AliFakharan/notebooklm-orchestrator.git
cd notebooklm-orchestrator
cp .env.example .env          # برای حالت زنده: NLO_PROVIDER=python-worker + NLO_PROXY_RUNTIME=xray
docker compose up --build -d
```

- **داده**: همه‌چیز در `./data` (SQLite، آرشیو شغل‌ها، vault، کوکی‌ها، venv
  worker داخل تصویر). بکاپ = کپی همین پوشه.
- **دسترسی**: به‌صورت پیش‌فرض فقط loopback هاست منتشر می‌شود. اپ **بدون احراز
  هویت کاربری** است؛ برای دسترسی از LAN/اینترنت، پورت را پشت یک **reverse
  proxy با احراز هویت** (مثلاً Authelia/Tailscale Funnel/Caddy+BasicAuth)
  قرار دهید (پورت compose را به `4870:4870` تغییر دهید). هرگز بدون لایه‌ی
  احراز هویت، مستقیم به شبکه باز نکنید.
- **خروج از کشور**: ترافیک گوگل fail-closed است و فقط از طریق نودهای VLESS
  تأییدشده می‌رود؛ نودها را طوری بچینید که egress از سرور شما خارج شود.
- **ورود حساب روی سرور headless**: چون ورود فقط با **چسباندن** کوکی است، نیازی
  به مرورگر روی خود سرور نیست — کوکی‌ها را روی دستگاه شخصی‌تان از مرورگر
  کپی و در UI سرور می‌چسبانید.
- کوکی‌های گوگل عمر محدود دارند؛ وقتی وضعیت حساب **EXPIRED** شد، همان
  چسباندن را تکرار کنید (دکمه‌ی «کوکی‌های مرورگر» در صفحه‌ی حساب‌ها).

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
- **دروازه‌ی admin اجباری** است: اجرای واقعی بدون `NLO_ADMIN_USER`/`NLO_ADMIN_PASSWORD` ممکن نیست؛ سطح job با loopback/IP مورد اعتماد، cookie admin یا کلید API (Bearer) باز می‌شود.
- ترافیک provider **fail-closed**: بدون پروکسیِ تأییدشده، direct egress نمی‌شود (تست‌شده با mock transport).
- secretها در vault با **AES-256-GCM**؛ UUID VLESS masked؛ logها redact.
- پیش‌فرض **mock** است؛ حالت زنده فقط با انتخاب صریح (`NLO_PROVIDER=python-worker` +
  `NLO_PROXY_RUNTIME=xray`) روشن می‌شود.
- جزئیات: [`docs/security.md`](docs/security.md)

## حالت زنده (live mode) — ورود واقعی + پراکسی واقعی + شغل واقعی

سیستم پیش‌فرض mock اجرا می‌شود و همه‌ی خروجی‌هایش با برچسب mock نمایش داده می‌شوند.
برای اجرای **واقعی** (درخواست به NotebookLM واقعی از طریق پروکسی واقعی):

```bash
# ۱) آماده‌سازی کارگر پایتونی (یک‌بار؛ خارج از Docker) — venv جدا از سیستم
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

# ۵) در UI:
#    - حساب بسازید (فقط ایمیل) ← «کوکی‌های مرورگر»: کوکی‌های نشستِ گوگل را از
#      مرورگر خود کپی و بچسبانید؛ سپس «تأیید جلسه» (verify واقعی در برابر سرویس).
#    - نود VLESS را paste کنید ← «تست پینگ همه نودها» (خروج + مقصد NotebookLM).

# ۶) اعتبارسنجی زنده (manual gate؛ هرگز در CI اجرا نمی‌شود)
npm run verify:live --workspace @nlo/server
```

**صادقانه بودن نتیجه:** هر شغل `resultProvenance` دارد — `real` فقط وقتی خود
provider گزارش کند که خروجی واقعی است؛ `mock` برای شبیه‌ساز؛ در غیر این صورت
`unknown`. صفحه‌ی جزئیات شغل این برچسب را کنار «پاسخ» نشان می‌دهد و هیچ‌جای UI
ادعای «زنده» بدون این مدرک نمی‌کند.

محدودیت‌های شناخته‌شده و وضعیت دقیق پیاده‌سازی:
[`docs/provider-evaluation.md`](docs/provider-evaluation.md) (بخش ۵).

## نگهداری نشست (Session Keeper) و اعلان بله

### Session Keeper — تازه‌نگه‌داشتن نشست‌های گوگل

یک حلقه‌ی پس‌زمینه در همان فرآیند سرور، هر `NLO_SESSION_KEEPALIVE_MS` (پیش‌فرض
`300000` = ۵ دقیقه) نشست‌های `AUTHENTICATED` را با همان مسیر verify واقعی
(از طریق تونل، fail-closed) دوباره بررسی می‌کند. هر verify هم **بررسی** است و هم
**تازه‌سازی**: notebooklm-py در هر فراخوانی یک poke `RotateCookies` انجام می‌دهد و
کوکی‌های چرخیده را دوباره در فایل `data/sessions/nlo-<accountId>.json` می‌نویسد.
این کار باعث می‌شود پنجره‌ی ۱۰ دقیقه‌ای «قابل‌استفاده» (`isUsable`) تا زمانی که سرور
روشن است برقرار بماند و به‌جای منقضی‌شدن، نشست تازه می‌ماند.

- فقط نشست‌های `AUTHENTICATED` poke می‌شوند؛ `AUTH_REQUIRED`/`DISABLED`/
  `AUTH_IN_PROGRESS` دست‌نخورده‌اند (کاربر باید خودش دوباره وارد شود — هیچ حمله‌ای
  به گوگل نمی‌شود).
- Keeper از `authGuard` مشترک با مسیرهای UI (import/verify) استفاده می‌کند؛ هیچ‌وقت
  با import/verify هم‌زمان روی همان فایل 0600 اجرا نمی‌شود.
- **خطای زیرساخت** (تونل/وورکر/timeout) هرگز نشست را `AUTH_REQUIRED` نمی‌کند
  (یعنی هشدار غلط «منقضی شد» نمی‌دهد)؛ فقط ثبت می‌شود و پس از ۳‌بار پیاپی یک اعلان
  یک‌باره‌ی «امکان بررسی نیست» می‌دهد.
- با `NLO_SESSION_KEEPALIVE_MS=0` غیرفعال می‌شود. زیر ۶۰ ثانیه نبرید (محدودیت
  rate-limit گوگل).

بررسی یک‌بارِ زنده (فرمان اپراتور، خارج از CI) برای پاسخ به «کوکی‌ها الان زنده‌اند؟»:

```bash
npm run check:sessions --workspace @nlo/server
```

### اعلان بله (Bale bot)

وقتی گوگل نشست یک اکانت را رد کند، یک پیام فارسی به چت خصوصی شما در **بله** می‌رود
(«نشست منقضی شد، دوباره وارد شوید و کوکی‌ها را paste کنید»)؛ هنگام بازگشت، پیام
«اکانت دوباره فعال شد»؛ و در ۳‌خطای زیرساختی پیاپی، یک پیام «امکان بررسی نیست».
بله چون سرویس داخلی است، بدون تونل VLESS هم کار می‌کند (API تلگرام در ایران مسدود است).

پیکربندی (در `.env`): `NLO_BALE_BOT_TOKEN` و `NLO_BALE_CHAT_ID`. اگر یکی خالی
بماند، اعلان غیرفعال است (بررسی‌ها همچنان انجام می‌شوند). توکن بات secret است و هرگز
لاگ/commit نمی‌شود.

- **این استقرار — انجام‌شده (۱۴۰۵/۰۸/۱۷، زنده و تأییدشده با `getMe` + `getUpdates`)**:
  بات `@nlo_alert_bot` (آیدی بات `184320790`). چت خصوصی شما با بات
  **`2101424173`** است. ⚠️ `184320790` را به‌عنوان `chat_id` استفاده نکنید — آن
  آیدیِ خودِ بات است و بات نمی‌تواند به خودش پیام بدهد.
- برای بات جدید: در بله با `@BotFather` (معادل بله) بات بسازید، توکن را بگیرید،
  یک‌بار `/start` بزنید تا `chat_id` خصوصی‌تان را از `getUpdates` بخوانید.

### FAQ: کوکی‌های نشست گوگل چقدر عمر می‌کنند؟

هیچ سند رسمی گوگل برای «عمر» کوکی/نشست وجود ندارد. شواهد محلی (اندازه‌گیری
تجربی):

- فیلد `Expires` کوکی روی دیسک **قابل‌اعتماد نیست** — گوگل `__Secure-1PSIDTS` را
  بر اساس ریتم داخلی خودش می‌چرخاند.
- اگر **کلاینت فعال دیگر** همان نشست گوگل را استفاده کند، اسنپ‌شات کوکیِ exportشده
  در ~۱۰ دقیقه ابطال و در ~۳۰ دقیقه شکست می‌خورد.
- اگر **تنها کلاینت** باشید، نشست‌ها روزها تا هفته‌ها دوام می‌آورند؛ انقضای ثابت
  مشاهده‌نشده است.
- گوگل می‌تواند در هر لحظه نشست را revoke کند (تغییر گذرواژه، رویداد امنیتی،
  احراز هویت مجدد).
- با pokeهای دوره‌ای `RotateCookies` (یعنی همین Session Keeper)، نشست به‌طور نامحدود
  تازه می‌ماند.

**قاعده‌ی عملی:** هرگز re-login را بر اساس تاریخ زمان‌بندی نکنید — زنده verify کنید.
یک poke پس‌زمینه (Session Keeper) مکانیسم درست است.

### کپی کوکی از گوشی

Chrome اندروید extension ندارد (راه مستقیم وجود ندارد). گزینه‌ها:

1. **Kiwi Browser** روی اندروید (Chrome-based با پشتیبانی از extension) + همان
   extension «کپی کوکی‌ها» که روی دسکتاپ استفاده می‌کنید.
2. هر **مرورگر دسکتاپ** (ساده‌ترین و مطمئن‌ترین).
3. حذف کپی دستی از طریق bootstrap با master-token (مرحله‌ی ۲، پیگیری بعدی).

iOS: پشتیبانی نمی‌شود.
