# امنیت — NotebookLM Orchestrator

## ۱. مودل تهدید

**محیط:** اپلیکیشن محلی، تک‌کاربر، لپ‌تاپ Ubuntu. فرض: کاربر سیستم را کنترل می‌کند؛ تهدیدهای اصلی:

1. **نشت secret** (cookie گوگل، UUID VLESS) در log، API، UI، آرشیو، یا Git
2. **egress غیرتأییدشده** — ترافیک provider بدون پروکسیِ انتخابی مستقیم خارج شود (fail-open)
3. **SSRF** از طریق endpointهای health-check با URL کاربری (دسترسی به localhost/metadata/private)
4. **path traversal / نام فایل بدافکارانه** در آپلود و آرشیو
5. **مدارک provider (خروجی Markdown/HTML) بدافکارانه** در UI (XSS)
6. **دسترسی شبکه‌ی محلی ناخواسته** به اپ (binding غیر-loopback)
7. **subprocess بدافکارانه** در worker پایتون (shell injection، argv leak)

**خارج از مودل:** حمله‌کننده‌ی فیزیکی، malware روی هاست، حمله‌ی insider به خودِ کاربر.

## ۲. Egress fail-closed (مهم‌ترین مرز امنیتی)

اصل: **ترافیک provider فقط از طریق listener محلیِ runtime پروکسی عبور می‌کند؛ هر شکست = خطا، هرگز direct.**

پیاده‌سازی (فعلاً با mock، test‌های قطعی):

- `EgressGuard` به provider client تحمیل می‌شود: transport شبکه‌ی provider فقط دو حالت دارد:
  - `proxy` → فقط به `127.0.0.1:<listenerPort>` وصل می‌شود (listener را ProxyRuntime بالا می‌آورد)
  - `direct` → transport «null» است که هر درخواست را **رد** می‌کند (در نسخه‌ی فعلی direct اصلاً فعال نیست)
- worker پایتون (در حالت live، فعلاً غیرفعال): env `HTTP(S)_PROXY` فقط روی فرزند تنظیم می‌شود؛ فرزند با `spawn` بدون shell، بدون secret در argv؛ پیکربندی در فایل 0600.
- testهای الزامی (فاز 5) — همه باید نشان دهند **خطا** می‌دهند نه direct-egress:
  proxy unavailable، tunnel down، conf نامعتبر، runtime crash، DNS failure، upstream timeout، egress IP نادرست، fallback node down، worker/app restart.
- health-check endpoint **URL دلخواً نمی‌پذیرد**: فقط destinationهای allowlist‌شده (پیش‌فرض: endpoint عمومی تشخیص egress IP). `assertAllowedDestination` حلقه‌ی محلی، شبکه‌های private و cloud metadata را رد می‌کند مگر در allowlist صریح.

**محدودیت شفاف:** در حالت mock، «fail-closed» روی transport mock تست می‌شود، نه روی خوراک واقعی. فعال‌سازی live مستلزم egress verification واقعی است (تست عبور از listener + بررسی IP خروجی).

## ۳. ذخیره‌ی secret (vault)

- الگوریتم: **AES-256-GCM** (Node crypto). هر record: `ciphertext + nonce(12B) + tag(16B)`؛ nonce تصادفی per-record.
- key: از env `NLO_VAULT_KEY` (hex ۶۴)؛ در نبودش، key file در `data/vault.key` با mode `0600` (create-on-first-use).
- مکان: `data/vault/` (خارج از Git). جدول `secrets` در SQLite فقط reference + ciphertext دارد.
- **محدودیت صادقانه:** key file و vault در یک دایرکتوری هستند → این vault در برابر «دسترسی غیرمجاز casual/backup اشتباه» محافظت می‌کند، نه در برابر کسی که به دایرکتوری `data/` دسترسی کامل دارد. این محدودیت آگاهانه برای نسخه‌ی محلی انتخاب شد؛ ارتقا به OS keyring یا key جدا در فاز بعد.
- secretها هرگز در: log (redaction layer)، پاسخ API، UI (فقط masked)، آرشیو job، exception payloadها.
- UUID VLESS فقط masked نمایش داده می‌شود (`••••-••••-••••-XXXX`)؛ URI کامل VLESS بعد از ثبت اولیه هرگز رندر نمی‌شود.
- در حالت توسعه، اگر vault واقعی هنوز در جریان خاصی استفاده نشود، **fake secret** استفاده می‌شود و این در UI با برچسب «mock» مشخص است — silent plaintext ذخیره نمی‌شود.

## ۴. آپلود و آرشیو

- محدودیت اندازه (پیش‌فرض 200 MB، env-configurable) و extension whitelist در سرور (`wav,mp3,m4a,ogg,flac`).
- نام فایل کاربر **هرگز** مستقیم به مسیر تبدیل نمی‌شود: `safeName()` (حروف غیر-[A-Za-z0-9._-] → `_`، طول capped) + مقادیر در `manifest.json`.
- تست path traversal: `../`، نول‌بایت، نام‌های absolut، unicode edge.
- hash (sha256) فایل ورودی در manifest برای یکسانی/دوباره‌ای.

## ۵. XSS و خروجی provider

- پاسخ Markdown با **DOMPurify** sanitize می‌شود (no scripts، no `file:`/`data:` image، no iframe).
- preview داخلی (app-generated) از خروجی واقعی provider در UI متمایز نشان داده می‌شود.

## ۶. شبکه و دسترسی

- binding پیش‌فرض: `127.0.0.1`. تغییر به `0.0.0.0` فقط با env صریح + هشدار.
- auth اختیاری admin: `NLO_ADMIN_TOKEN` (env) — اگر تنظیم شود، همه‌ی `/api` (مگر `/api/health`) نیاز به header `Authorization: Bearer <token>` دارند. **حساب admin سخت‌کد ندارد.**
- rate-limit روی API (بافت پیش‌فرض).
- graceful shutdown: در-flight jobs به `QUEUED` برمی‌گردند؛ listen socket بسته می‌شود؛ worker فرزند (در صورت وجود) SIGTERM→SIGKILL.

## ۷. subprocess (worker پایتون)

- `child_process.spawn` بدون shell؛ argv فقط: interpreter + worker script + **مسیر** فایل request (خودش secret نیست؛ secret در فایل 0600).
- timeout سخت + kill process group (`detached:true` + `process.kill(-pid)`).
- stdout = JSON-lines؛ هر خط با zod validate می‌شود؛ خط غیرمعتبر = fail.
- logهای worker قبل از ذخیره از همان redaction layer عبور می‌کنند (پترن cookie/UUID/password).

## ۸. Git hygiene

- `.gitignore` از ابتدا: `data/`, `node_modules/`, `dist/`, `.env*` (مگر نمونه‌ی بلافاصله)، `*.key`, آرشیوها.
- pre-commit check: `git grep` برای پترن‌های حساس در CI/تست‌های امنیتی (leak test).

## ۹. وضعیت پیاده‌سازی vs برنامه

| کنترل                            | وضعیت                                                  |
| -------------------------------- | ------------------------------------------------------ |
| fail-closed egress               | پیاده‌سازی + test (mock transport)                     |
| SSRF allowlist                   | پیاده‌سازی + test                                      |
| vault AES-256-GCM                | پیاده‌سازی + test (roundtrip، redaction، no-plaintext) |
| path safety                      | پیاده‌سازی + test                                      |
| DOMPurify                        | پیاده‌سازی (فرونت)                                     |
| loopback bind                    | پیش‌فرض + test                                         |
| Xray real egress                 | **غیرفعال** — نیازمند تأیید و نصب                      |
| egress verification واقعی (live) | **غیرفعال**                                            |
