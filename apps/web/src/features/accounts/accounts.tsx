import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  Download,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import {
  accountCreate,
  accountDelete,
  accountHealthCheck,
  accountSetDefault,
  accountUpdate,
  accountsList,
  providerInfo,
  sessionBrowserImport,
  sessionImport,
  sessionLogin,
  sessionLogout,
  sessionRefresh,
  sessionsList,
  BROWSER_COOKIE_OPTIONS,
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
import { Select } from "@/components/ui/select";
import { Dialog } from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
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
 * add / list / select / sign in / import an existing browser session /
 * verify / re-authenticate / set default / remove. All authentication is
 * UI-driven; the only unavoidable manual step is the interactive Google
 * sign-in in the user's own browser.
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
  const [pasteImporting, setPasteImporting] = useState<Account | null>(null);
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

  const patch = async (id: string, changes: Parameters<typeof accountUpdate>[1]) => {
    setBusyId(id);
    try {
      const updated = await accountUpdate(id, changes);
      setItems((l) => l?.map((a) => (a.id === id ? updated : a)) ?? null);
    } catch (err) {
      toast({ title: "به‌روزرسانی ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const probe = async (a: Account) => {
    setBusyId(a.id);
    try {
      const res = await accountHealthCheck(a.id);
      setItems((l) => l?.map((x) => (x.id === a.id ? res.account : x)) ?? null);
      toast({
        title: res.ok ? "حساب سالم است" : "مشکل در حساب",
        description: res.detail,
        variant: res.ok ? "success" : "error",
      });
    } catch (err) {
      toast({ title: "بررسی وضعیت ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const doLogin = async (a: Account) => {
    setBusyId(a.id);
    toast({
      title: "در حال باز کردن مرورگر برای ورود…",
      description:
        "در پنجره‌ای که باز می‌شود وارد گوگل شوید. اگر گوگل این مرورگر را رد کند (پیام «مرورگر یا اپلیکیشن ایمن نیست»), از «دریافت از مرورگر واقعی» استفاده کنید.",
      variant: "success",
    });
    try {
      await sessionLogin(a.id, { timeoutSec: 600 });
      toast({
        title: "ورود موفق بود",
        description: "جلسه ذخیره و در برابر سرویس واقعی تأیید شد.",
        variant: "success",
      });
    } catch (err) {
      toast({ title: "ورود ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setBusyId(null);
      void load();
    }
  };

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

  const doSetDefault = async (a: Account) => {
    setBusyId(a.id);
    try {
      await accountSetDefault(a.id, !a.isDefault);
      setItems(
        (l) => l?.map((x) => ({ ...x, isDefault: x.id === a.id ? !a.isDefault : false })) ?? null,
      );
      toast({
        title: a.isDefault ? "حساب پیش‌فرض حذف شد" : "حساب پیش‌فرض شد",
        description: a.isDefault
          ? undefined
          : "درخواست‌های جدید بدون انتخاب صریح، این حساب را به کار می‌برند.",
        variant: "success",
      });
    } catch (err) {
      toast({
        title: "تغییر حساب پیش‌فرض ناموفق بود",
        description: errMessage(err),
        variant: "error",
      });
    } finally {
      setBusyId(null);
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
                <TableHead>پیش‌فرض</TableHead>
                <TableHead>فعال</TableHead>
                <TableHead>آخرین موفقیت</TableHead>
                <TableHead>توضیح سقف</TableHead>
                <TableHead aria-label="عملیات" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <p className="text-sm font-medium">{a.label}</p>
                    {a.displayEmail && (
                      <p className="text-xs text-muted-foreground" dir="ltr">
                        {a.displayEmail}
                      </p>
                    )}
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
                        onLogin={() => void doLogin(a)}
                        onVerify={() => void doVerify(a)}
                        onLogout={() => void doLogout(a)}
                        onImportFromBrowser={() => setImporting(a)}
                        onPasteImport={() => setPasteImporting(a)}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={a.isDefault ? "حذف حالت پیش‌فرض" : "تنظیم به‌عنوان پیش‌فرض"}
                      title={a.isDefault ? "حساب پیش‌فرض فعلی" : "تنظیم به‌عنوان حساب پیش‌فرض"}
                      disabled={busyId === a.id}
                      onClick={() => void doSetDefault(a)}
                    >
                      <Star className={a.isDefault ? "fill-amber-400 text-amber-500" : undefined} />
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={a.enabled}
                      disabled={busyId === a.id}
                      aria-label={`فعال/غیرفعال ${a.label}`}
                      onCheckedChange={(on) => void patch(a.id, { enabled: on })}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <RelativeTime iso={a.lastSuccessAt} />
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-xs text-muted-foreground">
                    {a.quotaNote ?? "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="بررسی وضعیت"
                        disabled={busyId === a.id}
                        onClick={() => void probe(a)}
                      >
                        <RefreshCw className={busyId === a.id ? "animate-spin" : undefined} />
                      </Button>
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
      <BrowserImportDialog
        account={importing}
        onClose={() => setImporting(null)}
        onDone={() => void load()}
      />
      <PasteImportDialog
        account={pasteImporting}
        onClose={() => setPasteImporting(null)}
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
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!label.trim()) {
      setErr("برچسب حساب الزامی است.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await accountCreate({ label: label.trim(), displayEmail: email.trim() || undefined });
      toast({
        title: "حساب ثبت شد",
        description:
          "حالا با «دریافت از مرورگر واقعی» یا «ورود با مرورگر» وارد گوگل شوید و سپس تأیید کنید.",
        variant: "success",
      });
      setLabel("");
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
      description="شناسه‌ی داخلی به‌طور خودکار ساخته می‌شود. ایمیل نمایشی (در صورت درج) باعث می‌شود پس از ورود، هویت واقعیِ تأییدشده با آن مقایسه و ناسازگاری تشخیص داده شود."
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
        <Field label="برچسب" htmlFor="acc-label">
          <Input
            id="acc-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="مثلاً: حساب اصلی"
            error={err ?? undefined}
          />
        </Field>
        <Field label="ایمیل حساب گوگل (اختیاری، برای تشخیص ناسازگاری هویت)" htmlFor="acc-email">
          <Input
            id="acc-email"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@gmail.com"
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
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [quotaNote, setQuotaNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (account) {
      setLabel(account.label);
      setEmail(account.displayEmail);
      setQuotaNote(account.quotaNote ?? "");
      setErr(null);
    }
  }, [account]);

  if (!account) return null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await accountUpdate(account.id, {
        label: label.trim() || account.label,
        displayEmail: email.trim(),
        quotaNote: quotaNote.trim() || null,
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
        <Field label="برچسب" htmlFor="edit-label">
          <Input
            id="edit-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            error={err ?? undefined}
          />
        </Field>
        <Field label="ایمیل نمایشی" htmlFor="edit-email">
          <Input
            id="edit-email"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="توضیح سقف/کوتا (اختیاری)" htmlFor="edit-quota">
          <Input id="edit-quota" value={quotaNote} onChange={(e) => setQuotaNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ------------------------- browser cookie import -------------------------- */

const BROWSER_LABELS: Record<string, string> = {
  auto: "خودکار (هر مرورگر موجود)",
  chrome: "Google Chrome",
  firefox: "Firefox",
  chromium: "Chromium",
  brave: "Brave",
  edge: "Microsoft Edge",
  opera: "Opera",
  vivaldi: "Vivaldi",
  librewolf: "LibreWolf",
  zen: "Zen Browser",
  cachy: "Cachy Browser",
};

/**
 * دریافت از مرورگر واقعی — the primary sign-in path for environments where
 * Google rejects the app's automated Playwright browser. The user signs in
 * once with their normal browser; the app copies the session locally and
 * verifies it against the real service. Nothing is pasted or moved by hand.
 */
function BrowserImportDialog({
  account,
  onClose,
  onDone,
}: {
  account: Account | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [browser, setBrowser] = useState<string>("chrome");
  const [accountEmail, setAccountEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [routingNote, setRoutingNote] = useState<string | null>(null);

  useEffect(() => {
    if (account) {
      setBrowser("chrome");
      setAccountEmail(account.displayEmail || "");
      setErr(null);
      setRoutingNote(null);
    }
  }, [account]);

  if (!account) return null;

  const run = async () => {
    setBusy(true);
    setErr(null);
    setRoutingNote(null);
    try {
      const res = await sessionBrowserImport(account.id, {
        browser,
        account: accountEmail.trim() || undefined,
        timeoutSec: 180,
      });
      toast({
        title: "جلسه از مرورگر واقعی دریافت و تأیید شد",
        description: res.email ? `هویت تأییدشده: ${res.email}` : undefined,
        variant: "success",
      });
      setRoutingNote(res.routingNote ?? null);
      onDone();
    } catch (e) {
      const msg = errMessage(e);
      setErr(actionableImportError(msg));
      toast({ title: "دریافت جلسه ناموفق بود", description: msg, variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="دریافت جلسه از مرورگر واقعی"
      description="ابتدا در مرورگر عادیِ خود (همان‌جا که معمولاً کار می‌کنید) وارد notebooklm.google.com شوید؛ سپس اینجا مرورگر را انتخاب کنید تا برنامه‌ی این نشست را به‌صورت محلی و امن کپی کند. محتواً هیچ کوکی یا توکنی در این صفحه نمایش داده نمی‌شود."
      footer={
        <>
          <Button disabled={busy} onClick={() => void run()}>
            <Download />
            {busy ? "در حال دریافت و تأیید…" : "دریافت و تأیید"}
          </Button>
          <Button variant="outline" data-autofocus disabled={busy} onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="مرورگر"
          htmlFor="bi-browser"
          hint="فهرست مجاز برنامه‌است؛ مسیر یا اجرایی دلخواً نمی‌پذیرد."
        >
          <Select
            id="bi-browser"
            value={browser}
            disabled={busy}
            onChange={(e) => setBrowser(e.target.value)}
            options={BROWSER_COOKIE_OPTIONS.map((b) => ({
              value: b,
              label: BROWSER_LABELS[b] ?? b,
            }))}
          />
        </Field>
        <Field
          label="حساب گوگل مقصود (ایمیل)"
          htmlFor="bi-account"
          hint="اگر چند حساب گوگل در مرورگر واردشده است، با این ایمیل حساب درست انتخاب می‌شود. خالی بگذارید تا حساب پیش‌فرضِ مرورگر استفاده شود."
        >
          <Input
            id="bi-account"
            type="email"
            dir="ltr"
            value={accountEmail}
            disabled={busy}
            onChange={(e) => setAccountEmail(e.target.value)}
            placeholder="you@gmail.com"
          />
        </Field>
        {err && (
          <div className="rounded-field border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}
        {routingNote && (
          <div className="rounded-field border border-line bg-field p-3 text-xs text-muted-foreground">
            {routingNote}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          نکته: خودِ مرورگر در این مرحله از تونل VLESS استفاده نمی‌کند (خواندن کوکی از دیسک محلی
          است)؛ اما تأیید جلسه و تمام درخواست‌های بعدی به NotebookLM از تونل پیکربندی‌شده عبور
          می‌کنند.
        </p>
      </div>
    </Dialog>
  );
}

/** Turn raw import errors into clear, actionable guidance (Persian). */
function actionableImportError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("locked") || m.includes("busy")) {
    return "پایگاه کوکی مرورگر قفل است؛ مرورگر (یا تمام پنجره‌های آن) را ببندید و دوباره امتحان کنید.";
  }
  if (m.includes("decrypt") || m.includes("password") || m.includes("keyring")) {
    return "گشایش کوکی‌ها ممکن نبود (کلید رمزگشایی در دسترس نیست). مرورگر را یک‌بار دستی با گذرواژه‌ی سیستم باز و کوکی‌ها را نگه دارید، سپس دوباره امتحان کنید.";
  }
  if (m.includes("no cookies") || m.includes("not found") || m.includes("no valid google")) {
    return "کوکی معتبرِ گوگل در این مرورگر یافت نشد؛ مطمئن شوید در همین مرورگر (و همین نمایه) به حساب گوگل مقصود واردشده‌اید.";
  }
  if (m.includes("stale")) {
    return "کوکی‌های گوگل قدیمی/نامعتبر بودند؛ در مرورگر خود یک‌بار تازه وارد شوید و دوباره امتحان کنید.";
  }
  if (m.includes("mismatch")) {
    return "هویت حساب دریافتی با ایمیل این حساب مطابقت ندارد. ایمیل صحیح را در کادر بالا بگذارید و دوباره امتحان کنید.";
  }
  if (m.includes("proxy") || m.includes("tunnel") || m.includes("health")) {
    return "مسیر تونل برای تأیید در دسترس نبود. ابتدا در صفحه‌ی «پراکسی‌ها» یک گره سالم تأییدشده داشته باشید.";
  }
  return msg;
}

/* ----------------------- advanced storage-state paste --------------------- */

function PasteImportDialog({
  account,
  onClose,
  onDone,
}: {
  account: Account | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [jsonText, setJsonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (account) {
      setJsonText("");
      setErr(null);
    }
  }, [account]);

  if (!account) return null;

  const run = async () => {
    if (!jsonText.trim()) {
      setErr("JSON را چسبانده‌اید؟");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await sessionImport(account.id, {
        base64: btoa(unescape(encodeURIComponent(jsonText))),
      });
      if (res.mismatch) {
        toast({
          title: "ناسازگاری هویت",
          description: "هویت جلسه با این حساب مطابقت ندارد و به حالت نامعتبر درآمده است.",
          variant: "error",
        });
      } else {
        toast({
          title: res.ok ? "جلسه وارد و تأیید شد" : "جلسه پذیرفته نشد",
          description: res.detail ?? undefined,
          variant: res.ok ? "success" : "error",
        });
      }
      onDone();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="ورود پیشرفته: چسباندن storage-state"
      description="مسیر اختیاری برای کاربرانی که فایل storage_state.json با ساختار Playwright را دارند. محتوای چسبانده‌شده بررسی شده، به‌صورت ۰۶۰۰ ذخیره و در برابر سرویس واقعی تأیید می‌شود."
      footer={
        <>
          <Button disabled={busy || !jsonText.trim()} onClick={() => void run()}>
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
        <Field label="JSON storage-state" htmlFor="pi-json">
          <Textarea
            id="pi-json"
            dir="ltr"
            rows={8}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='{"cookies":[ ... ],"origins":[ ... ]}'
          />
        </Field>
        {err && <p className="text-xs font-medium text-destructive">{err}</p>}
      </div>
    </Dialog>
  );
}

/* ------------------------------ session cell ------------------------------ */

/**
 * SessionCell: the real auth-session state machine for one account and the
 * full action set (sign in / import from real browser / advanced paste /
 * verify / logout). States shown: not configured, ready, waiting, importing
 * (in progress), verified, expired, invalid, wrong account, re-auth needed.
 */
function SessionCell({
  view,
  busy,
  onLogin,
  onVerify,
  onLogout,
  onImportFromBrowser,
  onPasteImport,
}: {
  view: SessionAccountView | null;
  busy: boolean;
  onLogin: () => void;
  onVerify: () => void;
  onLogout: () => void;
  onImportFromBrowser: () => void;
  onPasteImport: () => void;
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
          هنوز جلسایی وجود ندارد؛ با «دریافت از مرورگر واقعی» شروع کنید.
        </p>
      )}
      {(state === "SESSION_EXPIRED" ||
        state === "SESSION_INVALID" ||
        state === "AUTH_REQUIRED") && (
        <p className="max-w-52 text-xs text-muted-foreground">
          برای ادامه، دوباره وارد شوید یا جلسه را از مرورگر واقعی به‌روزرسانی کنید.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          aria-label="دریافت از مرورگر واقعی"
          title="دریافت جلسه از مرورگر واقعی (توصیه‌شده وقتی گوگل مرورگر خودکار را رد کند)"
          disabled={busy || inProgress}
          onClick={onImportFromBrowser}
        >
          <Download />
          مرورگر واقعی
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="ورود با مرورگر"
          title="ورود تعاملی با مرورگر خودکار (ممکن است توسط گوگل رد شود)"
          disabled={busy || inProgress}
          onClick={onLogin}
        >
          <LogIn />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="ورود پیشرفته (storage-state)"
          title="چسباندن storage-state (پیشرفته)"
          disabled={busy || inProgress}
          onClick={onPasteImport}
        >
          <Upload />
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
