import { useCallback, useEffect, useState } from "react";
import { Boxes, KeyRound, LogOut, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  accountCreate,
  accountDelete,
  accountUpdate,
  accountsList,
  providerInfo,
  sessionImport,
  sessionLogout,
  sessionRefresh,
  sessionsList,
  SESSION_STATE_LABELS,
  type Account,
  type ProviderInfo,
  type SessionAccountView,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog } from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkeletonRow } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorBanner } from "@/components/shared/error-banner";
import { AccountStatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";
import { useToast } from "@/components/ui/toast";

/**
 * حساب‌ها — the single place to manage all Google accounts:
 * add / list / select / sign in (cookie paste) / verify / re-authenticate /
 * set default / remove. All authentication is UI-driven: the user signs in
 * to NotebookLM in their own browser, copies the session cookies, and pastes
 * them here. This app never launches a browser.
 */
export function AccountsPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [importing, setImporting] = useState<Account | null>(null);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionAccountView>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, pInfo] = await Promise.all([accountsList(), providerInfo().catch(() => null)]);
      setItems(list);
      if (pInfo) {
        setProvider(pInfo);
        if (!pInfo.isMock) {
          try {
            const ov = await sessionsList();
            setSessions(Object.fromEntries(ov.sessions.map((s) => [s.accountId, s])));
          } catch {
            /* sessions only exist with python-worker */
          }
        } else {
          setSessions({});
        }
      }
    } catch (err) {
      setError(errMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doVerify = async (a: Account) => {
    setBusyId(a.id);
    try {
      const res = await sessionRefresh(a.id);
      if (res.mismatch) {
        toast({
          title: "ناسازگاری هویت",
          description:
            "سرویس، این جلسه را به حسابی دیگر تعلق می‌دهد. برای جلوگیری از استفاده‌ی اشتباه، جلسه به حالت نامعتبر درآمده است.",
          variant: "error",
        });
      } else {
        toast({
          title: res.ok ? "جلسه تأیید شد" : "جلسه معتبر نیست",
          description: res.detail ?? undefined,
          variant: res.ok ? "success" : "error",
        });
      }
    } catch (err) {
      toast({ title: "بررسی جلسه ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setBusyId(null);
      void load();
    }
  };

  const doLogout = async (a: Account) => {
    setBusyId(a.id);
    try {
      await sessionLogout(a.id);
      toast({ title: "جلسه حذف شد", variant: "success" });
    } catch (err) {
      toast({ title: "حذف جلسه ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setBusyId(null);
      void load();
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await accountDelete(deleting.id);
      setItems((l) => l?.filter((a) => a.id !== deleting.id) ?? null);
      toast({
        title: "حساب حذف شد",
        description: "جلسه‌ی ذخیره‌شده‌ی این حساب نیز حذف شد.",
        variant: "success",
      });
      setDeleting(null);
      void load();
    } catch (err) {
      toast({ title: "حذف ناموفق بود", description: errMessage(err), variant: "error" });
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>حساب‌ها</CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            تازه‌سازی
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            حساب گوگل جدید
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <ErrorBanner message={error} onRetry={() => void load()} />}

        {!items ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} shimmer />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Boxes className="size-8" />}
            title="حسابی ثبت نشده"
            description="برای پردازش درخواست‌ها به حداقل یک حساب گوگل نیاز دارید."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                ثبت اولین حساب
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>حساب</TableHead>
                <TableHead>وضعیت</TableHead>
                {provider && !provider.isMock && <TableHead>جلسه (ورود واقعی)</TableHead>}
                <TableHead aria-label="عملیات" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <p className="text-sm font-medium">{a.displayEmail || a.label}</p>
                    {a.lastError && (
                      <p
                        className="mt-1 max-w-56 truncate text-xs text-destructive"
                        title={a.lastError}
                      >
                        {a.lastError}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <AccountStatusBadge status={a.status} />
                  </TableCell>
                  {provider && !provider.isMock && (
                    <TableCell>
                      <SessionCell
                        view={sessions[a.id] ?? null}
                        busy={busyId === a.id}
                        onVerify={() => void doVerify(a)}
                        onLogout={() => void doLogout(a)}
                        onImport={() => setImporting(a)}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="ویرایش"
                        onClick={() => setEditing(a)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="حذف"
                        onClick={() => setDeleting(a)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <CreateAccountDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => void load()}
      />
      <EditAccountDialog
        account={editing}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
      <CookieImportDialog
        account={importing}
        onClose={() => setImporting(null)}
        onDone={() => void load()}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="حذف حساب"
        description={
          deleting
            ? `حساب «${deleting.label}» برای همیشه حذف می‌شود؛ جلسه‌ی ورود ذخیره‌شده‌ی آن نیز پاک خواهد شد. این کار برگشت‌پذیر نیست.`
            : undefined
        }
        confirmText="حذف"
        destructive
        onConfirm={() => void doDelete()}
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function CreateAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim()) {
      setErr("ایمیل حساب گوگل الزامی است.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await accountCreate({ email: email.trim() });
      toast({
        title: "حساب ثبت شد",
        description:
          "حالا کوکی‌های نشستِ گوگل را از مرورگر خود کپی و در «ورود با کوکی‌های مرورگر» بچسبانید.",
        variant: "success",
      });
      setEmail("");
      onOpenChange(false);
      onCreated();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="حساب گوگل جدید"
      description="ایمیل، هویت حساب است (برچسب همان ایمیل می‌شود) و نمی‌تواند تکراری باشد. پس از ورود، هویت واقعیِ تأییدشده با آن مقایسه می‌شود."
      footer={
        <>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "در حال ثبت…" : "ثبت"}
          </Button>
          <Button variant="outline" data-autofocus onClick={() => onOpenChange(false)}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="ایمیل حساب گوگل" htmlFor="acc-email">
          <Input
            id="acc-email"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@gmail.com"
            error={err ?? undefined}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function EditAccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (account) {
      setEmail(account.displayEmail);
      setErr(null);
    }
  }, [account]);

  if (!account) return null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await accountUpdate(account.id, {
        displayEmail: email.trim(),
      });
      toast({ title: "حساب به‌روزرسانی شد", variant: "success" });
      onClose();
      onSaved();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="ویرایش حساب"
      description={`ویرایش «${account.label}»`}
      footer={
        <>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
          <Button variant="outline" data-autofocus onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="ایمیل حساب" htmlFor="edit-email">
          <Input
            id="edit-email"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={err ?? undefined}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/* ----------------- cookie paste import (the only auth path) ----------------- */

/**
 * ورود با کوکی‌های مرورگر — the ONLY way to sign an account in. The user
 * signs into notebooklm.google.com in their own (non-automated) browser,
 * copies the session cookies with any "copy cookies" extension, and pastes
 * them here. The server parses the paste (storage-state JSON / JSON cookie
 * array / Netscape cookies.txt), filters to google.com cookies, stores the
 * session 0600, and verifies it against the REAL service before it is green.
 */
function CookieImportDialog({
  account,
  onClose,
  onDone,
}: {
  account: Account | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (account) {
      setText("");
      setErr(null);
      setShowGuide(false);
    }
  }, [account]);

  if (!account) return null;

  const run = async () => {
    if (!text.trim()) {
      setErr("متن کوکی‌ها را وارد کرده‌اید؟");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await sessionImport(account.id, { cookies: text });
      if (res.mismatch) {
        toast({
          title: "ناسازگاری هویت",
          description:
            "هویت کوکی‌ها با ایمیل این حساب مطابقت ندارد و جلسه به حالت نامعتبر درآمده است. کوکی‌های همان حسابی که ایمیلش را در «ایمیل حساب» ثبت کرده‌اید بچسبانید.",
          variant: "error",
        });
      } else {
        toast({
          title: res.ok ? "جلسه وارد و تأیید شد" : "جلسه پذیرفته نشد",
          description: res.detail ?? undefined,
          variant: res.ok ? "success" : "error",
        });
      }
      if (res.ok) setText("");
      onDone();
    } catch (e) {
      setErr(actionableImportError(errMessage(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="ورود با کوکی‌های مرورگر"
      description="در مرورگر عادی خود (همان‌جا که معمولاً کار می‌کنید) وارد notebooklm.google.com شوید، کوکی‌های نشستِ گوگل را با افزونه‌ی «کپی کوکی‌ها» کپی کنید و اینجا بچسبانید. برنامه مرورگری باز نمی‌کند و به کوکی‌های مرورگر شما دسترسی مستقیم ندارد."
      footer={
        <>
          <Button disabled={busy || !text.trim()} onClick={() => void run()}>
            <Upload />
            {busy ? "در حال ذخیره و تأیید…" : "ذخیره و تأیید"}
          </Button>
          <Button variant="outline" data-autofocus disabled={busy} onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="کوکی‌های کپی‌شده (JSON یا cookies.txt)" htmlFor="ci-cookies">
          <Textarea
            id="ci-cookies"
            dir="ltr"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              '{"cookies":[ ... ]}  یا  [{"domain":".google.com","name":"SID",...}]  یا  cookies.txt'
            }
          />
        </Field>
        {err && <p className="text-xs font-medium text-destructive">{err}</p>}
        <button
          type="button"
          className="self-start text-xs text-primary underline underline-offset-2"
          onClick={() => setShowGuide((v) => !v)}
        >
          {showGuide ? "بستن راهنمای کپی کوکی" : "راهنمای کپی کوکی از مرورگر"}
        </button>
        {showGuide && (
          <div
            dir="ltr"
            className="max-h-64 overflow-auto whitespace-pre-wrap rounded-field border border-line bg-field p-3 text-left text-xs leading-6 text-muted-foreground"
          >
            {COOKIE_COPY_GUIDE}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Per-browser how-to for copying the signed-in Google session cookies. */
const COOKIE_COPY_GUIDE = `Chrome / Chromium / Brave / Edge (Windows & Linux):
1. Install the "Cookie-Editor" (or "Get cookies.txt LOCALLY") extension.
2. Open https://notebooklm.google.com in the profile you are signed into
   (it must show your notebooks — if it redirects to sign-in, sign in first).
3. Click the extension icon; choose "Copy as JSON" (Cookie-Editor) or
   "Copy as cookies.txt"; paste it here.
   Tip: filter by domain "google.com" before copying — only google.com
   cookies are needed.

Firefox:
1. Install the "Cookie Quick Manager" (or "cookies.txt") extension.
2. Open https://notebooklm.google.com signed in.
3. Site data > select the google.com cookies > "Export to cookies.txt" (or
   copy as JSON); paste it here.

Safari (macOS/iOS): no extension store — use the Console:
   (window.localStorage + cookie access is restricted; the supported route
   on macOS is "Develop > Show JavaScript Console" and copying the
   Document.cookie of the notebooklm.google.com tab — this covers the
   non-HttpOnly session cookies; for full fidelity use Chrome/Firefox.)

All formats are auto-detected:
  * Playwright storage state  {"cookies":[...],"origins":[...]}
  * JSON cookie array         [{"domain":".google.com","name":...}, ...]
  * Netscape cookies.txt      #HttpOnly_.google.com <TAB> TRUE <TAB> / ...

Only google.com cookies are kept; a paste without them is rejected.`;

/** Turn raw import errors into clear, actionable guidance (Persian). */
function actionableImportError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("no google.com cookies")) {
    return "کوکی‌های google.com در متن یافت نشد؛ کوکی‌های همان نمایه‌ای را که با آن به NotebookLM واردشده‌اید کپی کنید (ترجیحاً با فیلتر روی دامنه‌ی google.com).";
  }
  if (m.includes("not valid") || m.includes("unrecognized") || m.includes("json")) {
    return "متن واردشده خوانده نشد؛ خروجی افزونه را کامل کپی کنید (JSON کامل یا کل فایل cookies.txt) — نه بخشی از آن.";
  }
  if (m.includes("missing") || m.includes("cookie")) {
    return "ساختار کوکی‌ها ناقص به نظر می‌رسد؛ از خروجی مستقیم افزونه (Copy as JSON / cookies.txt) استفاده کنید.";
  }
  if (
    m.includes("stale") ||
    m.includes("expired") ||
    m.includes("re-auth") ||
    m.includes("rejected")
  ) {
    return "کوکی‌های گوگل قدیمی/نامعتبر بودند؛ در مرورگر خود یک‌بار تازه وارد NotebookLM شوید، دوباره کپی و بچسبانید.";
  }
  if (m.includes("mismatch")) {
    return "هویت حساب دریافتی با ایمیل این حساب مطابقت ندارد. کوکی‌های همان حسابی را که ایمیلش در حساب ثبت شده بچسبانید.";
  }
  if (m.includes("proxy") || m.includes("tunnel") || m.includes("health")) {
    return "مسیر تونل برای تأیید در دسترس نبود. ابتدا در صفحه‌ی «پراکسی‌ها» یک گره سالم تأییدشده داشته باشید.";
  }
  if (m.includes("too large")) {
    return "ورودی خیلی بزرگ است؛ فقط کوکی‌های google.com را کپی کنید.";
  }
  return msg;
}

/* ------------------------------ session cell ------------------------------ */

/**
 * SessionCell: the real auth-session state machine for one account and the
 * full action set (cookie-paste import / verify / logout). States shown: not
 * configured, ready, verified, expired, invalid, wrong account, re-auth needed.
 */
function SessionCell({
  view,
  busy,
  onVerify,
  onLogout,
  onImport,
}: {
  view: SessionAccountView | null;
  busy: boolean;
  onVerify: () => void;
  onLogout: () => void;
  onImport: () => void;
}) {
  const state = view?.session?.state ?? "UNKNOWN";
  const email = view?.session?.email ?? null;
  const verifiedAt = view?.session?.lastVerifiedAt ?? null;
  const lastError = view?.session?.lastError ?? null;
  const usable = view?.sessionUsable ?? false;
  const inProgress = state === "AUTH_IN_PROGRESS";
  const wrongAccount = lastError?.toLowerCase().includes("mismatch") ?? false;

  const variant: "success" | "warning" | "destructive" | "secondary" =
    state === "AUTHENTICATED" && usable
      ? "success"
      : inProgress
        ? "warning"
        : state === "SESSION_EXPIRED" ||
            state === "SESSION_INVALID" ||
            state === "ACCESS_UNAVAILABLE"
          ? "destructive"
          : "secondary";

  const stateLabel =
    state === "UNKNOWN" && !view?.session
      ? "پیکربندی‌نشده"
      : inProgress
        ? "در انتظار ورود کاربر"
        : SESSION_STATE_LABELS[state];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Badge variant={variant}>{stateLabel}</Badge>
        {email && (
          <span className="max-w-32 truncate text-xs text-muted-foreground" dir="ltr" title={email}>
            {email}
          </span>
        )}
        {wrongAccount && <span className="text-xs font-medium text-destructive">حساب اشتباه!</span>}
      </div>
      {lastError && (
        <p className="max-w-52 truncate text-xs text-destructive" title={lastError}>
          {lastError}
        </p>
      )}
      {!view?.session && (
        <p className="max-w-52 text-xs text-muted-foreground">
          هنوز جلسه‌ای وجود ندارد؛ با «ورود با کوکی‌های مرورگر» شروع کنید.
        </p>
      )}
      {(state === "SESSION_EXPIRED" ||
        state === "SESSION_INVALID" ||
        state === "AUTH_REQUIRED") && (
        <p className="max-w-52 text-xs text-muted-foreground">
          برای ادامه، کوکی‌های تازه‌ی مرورگر خود را دوباره کپی و وارد کنید.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          aria-label="ورود با کوکی‌های مرورگر"
          title="کپی‌شده‌ی کوکی‌های نشستِ گوگل را از مرورگر خود بچسبانید (تغییر/به‌روزرسانی جلسه هم از همین‌جا)"
          disabled={busy || inProgress}
          onClick={onImport}
        >
          <Upload />
          کوکی‌های مرورگر
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="تأیید جلسه"
          title="تأیید در برابر سرویس واقعی"
          disabled={busy || inProgress}
          onClick={onVerify}
        >
          <KeyRound className={busy ? "animate-spin" : undefined} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="حذف جلسه"
          title="حذف جلسه (خروج)"
          disabled={busy || inProgress}
          onClick={onLogout}
        >
          <LogOut />
        </Button>
        {verifiedAt && (
          <span className="ms-1 text-xs text-muted-foreground">
            تأیید: <RelativeTime iso={verifiedAt} />
          </span>
        )}
      </div>
    </div>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "خطای نامشخص";
}
