import { useCallback, useEffect, useState } from "react";
import { Boxes, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  accountCreate,
  accountDelete,
  accountHealthCheck,
  accountUpdate,
  accountsList,
  type Account,
} from "@/lib/api";
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

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await accountsList());
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
