# NotebookLM Orchestrator

اپلیکیشن **محلی** (تک‌کاربر، loopback) برای مدیریت درخواست‌های «صوت + دستور» به NotebookLM،
مدیریت حساب‌های گوگل و نودهای VLESS، اجرای نوبتی کارها، آرشیو و نمایش فارسی RTL.

- مستندات: [`docs/architecture.md`](docs/architecture.md)، [`docs/security.md`](docs/security.md)،
  [`docs/provider-evaluation.md`](docs/provider-evaluation.md)، [`docs/proxy-design.md`](docs/proxy-design.md)،
  [`docs/development-plan.md`](docs/development-plan.md)
- مخازن مرجع (فقط مرجع، اجرا نمی‌شوند): `../research/`

## اجرا (توسعه)

```bash
npm install
npm run dev          # server روی 127.0.0.1:4870 + web روی 127.0.0.1:5173 (proxy /api به server)
```

بعد از `npm run build`، server همان `apps/web/dist` را با SPA fallback روی 127.0.0.1:4870 سرو می‌کند
(یک پورت برای همه: API + وب). مسیرهای /api در 404، envelope JSON نگه می‌مانند.

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
- provider واقعی (python worker) و runtime واقعی پروکسی (Xray) **غیرفعال** تا تأیید صریح کاربر.
- جزئیات: [`docs/security.md`](docs/security.md)
