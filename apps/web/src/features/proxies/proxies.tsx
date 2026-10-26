import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Cable, ClipboardPaste, Trash2, Wifi } from "lucide-react";
import {
  proxyDeleteMany,
  proxyHealthCheck,
  proxyRuntimeStatus,
  proxiesImport,
  proxiesList,
  type MaskedProxyNode,
  type ProxiesImportResult,
  type ProxyHealthResult,
  type ProxyRuntimeStatus,
} from "@/lib/api";
import { fa } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog } from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorBanner } from "@/components/shared/error-banner";
import { RelativeTime } from "@/components/shared/relative-time";
import { useToast } from "@/components/ui/toast";

/**
 * پراکسی‌ها — VLESS node management. UUIDs are stored server-side in the
 * vault; the API only ever returns the masked form, and this page displays
 * exactly that. Health/connectivity checks are triggered from here and
 * always run server-side through the SSRF-guarded runtime.
 */
export function ProxiesPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<MaskedProxyNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pinging, setPinging] = useState(false);
  /** Node ids currently being checked (rows show "در حال تست…"). */
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());
  const [lastPing, setLastPing] = useState<{ at: string; target: string } | null>(null);

  // Table multi-select for batch delete.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [runtime, setRuntime] = useState<ProxyRuntimeStatus | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await proxiesList());
    } catch (err) {
      setError(errMessage(err));
    }
    try {
      setRuntime(await proxyRuntimeStatus());
    } catch {
      setRuntime(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Drop selection entries that no longer exist (deleted / reloaded list).
  useEffect(() => {
    if (!items) return;
    setSelected((s) => {
      const live = new Set(items.map((n) => n.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of s) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : s;
    });
  }, [items]);

  const toggleAll = (on: boolean) => {
    setSelected(on && items ? new Set(items.map((n) => n.id)) : new Set());
  };

  const doBatchDelete = async () => {
    if (selected.size === 0) return;
    const ids = [...selected];
    setDeleting(true);
    try {
      await proxyDeleteMany(ids);
      setItems((l) => l?.filter((n) => !selected.has(n.id)) ?? null);
      toast({ title: `${fa(ids.length)} نود حذف شد`, variant: "success" });
      setSelected(new Set());
      setConfirmDelete(false);
    } catch (err) {
      toast({ title: "حذف ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Ping every node to notebooklm.google.com:443 with bounded concurrency.
   * Runs the per-node health endpoint client-side (same staged, SSRF-guarded
   * check the table button uses) and merges each result into the table the
   * moment it lands — the list re-sorts after every completion instead of
   * waiting for the slowest node.
   */
  const doPingAll = async () => {
    if (!items || items.length === 0) return;
    setPinging(true);
    setCheckingIds(new Set(items.map((n) => n.id)));
    const startedAt = new Date().toISOString();
    let bad = 0;
    let next = 0;
    const runOne = async (n: MaskedProxyNode) => {
      try {
        const res: ProxyHealthResult = await proxyHealthCheck(n.id, { target: "notebooklm" });
        if (!res.ok) bad += 1;
        // The response carries the refreshed node (with its new health row).
        setItems((l) => (l ? l.map((x) => (x.id === res.node.id ? res.node : x)) : l));
      } catch {
        bad += 1;
        // Node stays on its previous state; the row just stops spinning.
      } finally {
        setCheckingIds((s) => {
          const t = new Set(s);
          t.delete(n.id);
          return t;
        });
      }
    };
    const workers = Array.from({ length: Math.min(6, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await runOne(items[i]!);
      }
    });
    await Promise.all(workers);
    setPinging(false);
    setLastPing({ at: startedAt, target: "notebooklm.google.com:443" });
    toast({
      title: `بررسی ${fa(items.length)} نود تمام شد`,
      description:
        bad === 0
          ? "همه نودها پاسخ دادند."
          : `${fa(bad)} نود پاسخ ندادند؛ جزئیات را از ستون پینگ ببینید.`,
      variant: bad === 0 ? "success" : "default",
    });
  };

  /**
   * Display order: nodes that answered last, fastest ping first; nodes that
   * failed (or were never checked) go to the bottom, oldest failures first.
   * Recomputed on every state change, so rows re-sort as pings complete.
   */
  const sorted = useMemo(() => {
    if (!items) return null;
    const key = (n: MaskedProxyNode) => {
      const h = n.health;
      if (!h || !h.lastCheckedAt) return { t: 2, ms: 0, at: "" };
      if (!h.ok) return { t: 1, ms: h.latencyMs ?? 0, at: h.lastCheckedAt };
      return { t: 0, ms: h.latencyMs ?? 0, at: h.lastCheckedAt };
    };
    return [...items].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka.t !== kb.t) return ka.t - kb.t;
      if (ka.t === 0 && ka.ms !== kb.ms) return ka.ms - kb.ms;
      if (ka.at !== kb.at) return ka.at < kb.at ? 1 : -1;
      return a.config.name.localeCompare(b.config.name);
    });
  }, [items]);

  const allSelected = !!items && items.length > 0 && items.every((n) => selected.has(n.id));
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>پراکسی‌ها</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            رمزهای VLESS (UUID) در گاوصندوق سرور نگهداری می‌شوند؛ اینجا فقط شکل ماسک‌دار نمایش داده
            می‌شود.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={selected.size === 0 || deleting}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
            حذف انتخاب‌شده‌ها{selected.size > 0 ? ` (${fa(selected.size)})` : ""}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pinging || !items || items.length === 0}
            onClick={() => void doPingAll()}
          >
            <Activity className={pinging ? "animate-pulse" : undefined} />
            {pinging
              ? `در حال بررسی ${fa(checkingIds.size)} نود باقی‌مانده…`
              : "تست پینگ همه نودها"}
          </Button>
          <Button size="sm" onClick={() => setImporting(true)}>
            <ClipboardPaste />
            افزودن از کلیپ‌بورد
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <ErrorBanner message={error} onRetry={() => void load()} />}
        {lastPing && (
          <p className="mb-2 text-xs text-muted-foreground">
            آخرین تست پینگ گروهی به مقصد <span dir="ltr">{lastPing.target}</span> :{" "}
            <RelativeTime iso={lastPing.at} />
          </p>
        )}

        {runtime && runtime.state !== "available" && (
          <p className="mb-3 rounded-field border border-warning/40 bg-warning/10 p-3 text-xs leading-6">
            <span className="font-medium">پراکسی‌رات‌تایم در دسترس نیست: </span>
            <span dir="ltr" className="font-medium">
              {runtime.name}
            </span>{" "}
            — {runtime.reason ?? ""}
            {runtime.name === "xray" && (
              <>
                . فایل bin/xray را در{" "}
                <code className="rounded bg-field px-1 py-0.5" dir="ltr">
                  data/vendor/xray/xray
                </code>{" "}
                قرار دهید تا تونل‌های واقعی فعال شوند.
              </>
            )}
          </p>
        )}

        {!items ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Cable className="size-8" />}
            title="نود VLESS تعریف نشده"
            description="لیست vless:// خود (مثلا از اپ پراکسی) را در کلیپ‌بورد کپی کنید و با دکمه «افزودن از کلیپ‌بورد» بفرستید."
            action={
              <Button size="sm" onClick={() => setImporting(true)}>
                <ClipboardPaste />
                افزودن از کلیپ‌بورد
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(v) => toggleAll(v)}
                    aria-label="انتخاب همه"
                  />
                </TableHead>
                <TableHead>نود</TableHead>
                <TableHead>سرور</TableHead>
                <TableHead className="text-left tabular-nums">پینگ (NotebookLM)</TableHead>
                <TableHead aria-label="عملیات" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sorted ?? items).map((n) => (
                <TableRow key={n.id} data-state={selected.has(n.id) ? "selected" : undefined}>
                  <TableCell className="w-8">
                    <Checkbox
                      checked={selected.has(n.id)}
                      onCheckedChange={(v) =>
                        setSelected((s) => {
                          const t = new Set(s);
                          if (v) t.add(n.id);
                          else t.delete(n.id);
                          return t;
                        })
                      }
                      aria-label={`انتخاب ${n.config.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-56 truncate text-start text-sm font-medium">
                      {n.config.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs" dir="ltr">
                    {n.config.server}:{fa(n.config.port)}
                  </TableCell>
                  <TableCell numeric>
                    <PingCell node={n} checking={busyId === n.id || checkingIds.has(n.id)} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="تست پینگ"
                      disabled={busyId === n.id}
                      onClick={async () => {
                        setBusyId(n.id);
                        try {
                          const res = await proxyHealthCheck(n.id, { target: "notebooklm" });
                          // Merge the refreshed node in place (re-sorts too).
                          setItems((l) =>
                            l ? l.map((x) => (x.id === res.node.id ? res.node : x)) : l,
                          );
                          toast({
                            title: res.ok ? `پینگ ${fa(res.latencyMs ?? 0)} ms` : "پینگ ناموفق بود",
                            description: res.ok ? undefined : res.error,
                            variant: res.ok ? "success" : "error",
                          });
                        } catch (e) {
                          toast({
                            title: "بررسی ناموفق بود",
                            description: errMessage(e),
                            variant: "error",
                          });
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      <Wifi className={busyId === n.id ? "animate-pulse" : undefined} />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <ImportDialog open={importing} onOpenChange={setImporting} onImported={() => void load()} />

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(o) => !o && !deleting && setConfirmDelete(false)}
        title="حذف نودهای انتخاب‌شده"
        description={`${fa(selected.size)} نود و رمزهای UUID آن‌ها (هرکجا دیگر استفاده نشوند) از گاوصندوق حذف می‌شوند. این کار برگشت‌پذیر نیست.`}
        confirmText="حذف"
        destructive
        onConfirm={() => void doBatchDelete()}
      />
    </Card>
  );
}

/* -------------------------------- ping cell -------------------------------- */

/**
 * Colored ping: <500ms green (سبز), 500–1500ms yellow (زرد), >1500ms red
 * (قرمز). "بدون پاسخ" (no answer) is red, "تست نشده" (never tested) is
 * muted. The tooltip carries the last check time and error, if any.
 */
function PingCell({ node, checking }: { node: MaskedProxyNode; checking: boolean }) {
  const h = node.health;
  if (checking) {
    return <span className="text-xs text-muted-foreground">در حال تست…</span>;
  }
  if (!h || !h.lastCheckedAt) {
    return <span className="text-xs text-muted-foreground">تست نشده</span>;
  }
  const label = (
    <span className="flex items-center justify-end gap-1.5 text-xs tabular-nums">
      <span
        className={`size-2 rounded-full ${
          !h.ok
            ? "bg-destructive"
            : h.latencyMs! < 500
              ? "bg-success"
              : h.latencyMs! <= 1500
                ? "bg-warning"
                : "bg-destructive"
        }`}
        aria-hidden
      />
      {h.ok && h.latencyMs !== null ? `${fa(h.latencyMs)} ms` : "بدون پاسخ"}
    </span>
  );
  const tip = h.ok ? `پاسخ در ${fa(h.latencyMs ?? 0)} ms` : (h.error ?? "ناموفق");
  return <span title={`${tip} — آخرین بررسی: ${h.lastCheckedAt}`}>{label}</span>;
}

/* ------------------------------- import dialog ------------------------------- */

/**
 * Paste import: the user copies a provider's share list (many vless:// URIs,
 * one per line) into the clipboard and hits the button; the textarea is
 * pre-filled from the clipboard when the browser permission allows, with a
 * manual-paste fallback. The server validates every line independently and
 * reports per-line results — a few bad lines never abort the good ones.
 */
function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    total: number;
    added: number;
    skipped: number;
    errors: number;
    results: ProxiesImportResult[];
  } | null>(null);

  // Fill from the clipboard when the dialog opens (permission-gated; the
  // user can always paste manually into the textarea).
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setErr(null);
    const clip = navigator.clipboard;
    if (clip && "readText" in clip) {
      clip
        .readText()
        .then((t) => {
          if (t.trim()) setText(t);
        })
        .catch(() => {
          /* permission denied — manual paste */
        });
    }
  }, [open]);

  const lineCount = useMemo(() => (text.trim() ? text.trim().split(/\s+/).length : 0), [text]);

  const submit = async () => {
    if (!text.trim()) {
      setErr("متن خالی است؛ ابتدا کانفیگ‌ها را در کادر بچسبانید.");
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await proxiesImport({ text });
      setResult(res);
      if (res.added > 0) {
        toast({
          title: `${fa(res.added)} نود افزوده شد`,
          description:
            res.skipped > 0 || res.errors > 0
              ? `${fa(res.skipped)} تکراری رد شد، ${fa(res.errors)} خطا داشت — جزئیات زیر.`
              : undefined,
          variant: res.errors > 0 ? "default" : "success",
        });
      } else {
        toast({
          title: "هیچ نود جدیدی افزوده نشد",
          description:
            res.errors > 0
              ? `${fa(res.errors)} خطا داشت — جزئیات زیر.`
              : "همه‌ی کانفیگ‌ها تکراری بودند.",
          variant: "error",
        });
      }
      onImported();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setText("");
    setResult(null);
    setErr(null);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="افزودن نود از کلیپ‌بورد"
      description="لیست کانفیگ vless:// (مثلا از اپ پراکسی) را کپی کنید؛ هر خط جداگانه اعتبارسنجی می‌شود و تکراری‌ها خودکار رد می‌شوند."
      footer={
        <>
          <Button disabled={busy || !text.trim()} onClick={() => void submit()}>
            {busy ? "در حال بررسی و افزودن…" : "افزودن"}
          </Button>
          <Button variant="outline" data-autofocus disabled={busy} onClick={close}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <p className="mb-1 text-xs font-medium">کانفیگ‌ها (هر خط یک URI)</p>
          <Textarea
            id="import-uris"
            dir="ltr"
            rows={9}
            placeholder={
              "vless://uuid@host:443?security=tls&type=ws&path=/x#نام 1\nvless://uuid@host2:443#نام 2"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {err && <p className="mt-1 text-xs font-medium text-destructive">{err}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            {lineCount > 0
              ? `${fa(lineCount)} URI شناسایی شد. اگر کلیپ‌بورد اجازه نداد خودکار پر شود، دستی Ctrl+V بزنید.`
              : "هنوز متنی وارد نشده است."}
          </p>
        </div>

        {result && (
          <div className="max-h-48 overflow-auto rounded-field border border-border bg-field/50 p-3">
            <p className="mb-2 text-xs font-medium">
              نتیجه: از {fa(result.total)} URI — {fa(result.added)} افزوده شد، {fa(result.skipped)}{" "}
              تکراری رد شد، {fa(result.errors)} خطا داشت.
            </p>
            <ul className="flex flex-col gap-1 text-xs">
              {result.results.map((r) => (
                <li key={r.line} className="flex items-center gap-2">
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      r.status === "added"
                        ? "bg-success"
                        : r.status === "skipped"
                          ? "bg-muted-foreground/50"
                          : "bg-destructive"
                    }`}
                    aria-hidden
                  />
                  <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
                    خط {fa(r.line)}
                  </span>
                  {r.server && (
                    <span className="shrink-0" dir="ltr">
                      {r.server}:{fa(r.port ?? 0)}
                    </span>
                  )}
                  <span
                    className={r.status === "error" ? "text-destructive" : "text-muted-foreground"}
                  >
                    {r.status === "added"
                      ? "افزوده شد"
                      : r.status === "skipped"
                        ? r.reason === "duplicate within pasted list"
                          ? "تکراری در همین لیست"
                          : "قبلا وجود دارد"
                        : (r.reason ?? "خطا")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "خطای نامشخص";
}
