import { useCallback, useEffect, useState } from "react";
import { Boxes, KeyRound, LogIn, LogOut, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  accountCreate,
  accountDelete,
  accountHealthCheck,
  accountUpdate,
  accountsList,
  providerInfo,
  sessionLogin,
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
 * حساب‌ها — manage provider accounts: create, rename, enable/disable,
 * delete, and run the provider's safe health probe (no secrets cross the
 * API — only the masked display fields are shown).
 */
export function AccountsPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
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
        "در پنجره‌ی مرورگر که باز می‌شود وارد گوگل شوید. این عملیات تا تکمیل یا انقضا طول می‌کشد.",
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
      toast({
        title: res.ok ? "جلسه تأیید شد" : "جلسه معتبر نیست",
        description: res.detail ?? undefined,
        variant: res.ok ? "success" : "error",
      });
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
      toast({ title: "حساب حذف شد", variant: "success" });
      setDeleting(null);
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
            حساب جدید
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
            description="برای پردازش درخواست‌ها به حداقل یک حساب ارائه‌دهنده نیاز دارید."
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
                      />
                    </TableCell>
                  )}
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

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="حذف حساب"
        description={
          deleting
            ? `حساب «${deleting.label}» برای همیشه حذف می‌شود. این کار برگشت‌پذیر نیست.`
            : undefined
        }
        confirmText="حذف"
        destructive
        onConfirm={() => void doDelete()}
      />
    </Card>
  );
}

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
        description: "حساب در وضعیت «نیازمند احراز هویت» است.",
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
      title="حساب جدید"
      description="معلومات عمومی حساب. ذخیره‌ی رمز عبور از طریق این پنل انجام نمی‌شود."
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
        <Field label="ایمیل نمایشی (اختیاری)" htmlFor="acc-email">
          <Input
            id="acc-email"
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "خطای نامشخص";
}

/**
 * SessionCell: shows the real auth-session state for an account and offers
 * the three live actions (login / verify / logout). Only rendered when the
 * active provider is the python-worker (mock has no real session).
 */
function SessionCell({
  view,
  busy,
  onLogin,
  onVerify,
  onLogout,
}: {
  view: import("@/lib/api").SessionAccountView | null;
  busy: boolean;
  onLogin: () => void;
  onVerify: () => void;
  onLogout: () => void;
}) {
  const state = view?.session?.state ?? "UNKNOWN";
  const email = view?.session?.email ?? null;
  const verifiedAt = view?.session?.lastVerifiedAt ?? null;
  const lastError = view?.session?.lastError ?? null;
  const usable = view?.sessionUsable ?? false;

  const variant: "success" | "warning" | "destructive" | "secondary" =
    state === "AUTHENTICATED"
      ? "success"
      : state === "AUTH_IN_PROGRESS"
        ? "warning"
        : state === "SESSION_EXPIRED" ||
            state === "SESSION_INVALID" ||
            state === "ACCESS_UNAVAILABLE"
          ? "destructive"
          : "secondary";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Badge variant={variant}>{SESSION_STATE_LABELS[state]}</Badge>
        {email && (
          <span className="max-w-32 truncate text-xs text-muted-foreground" dir="ltr" title={email}>
            {email}
          </span>
        )}
      </div>
      {lastError && (
        <p className="max-w-48 truncate text-xs text-destructive" title={lastError}>
          {lastError}
        </p>
      )}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="ورود"
          title="ورود با مرورگر"
          disabled={busy}
          onClick={onLogin}
        >
          <LogIn />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="تأیید جلسه"
          title="تأیید در برابر سرویس واقعی"
          disabled={busy}
          onClick={onVerify}
        >
          <KeyRound className={busy ? "animate-spin" : undefined} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="خروج"
          title="حذف جلسه"
          disabled={busy}
          onClick={onLogout}
        >
          <LogOut />
        </Button>
        {verifiedAt && (
          <span className="ms-1 text-xs text-muted-foreground">
            <RelativeTime iso={verifiedAt} />
          </span>
        )}
      </div>
    </div>
  );
}
