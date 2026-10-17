import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Cable,
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wifi,
  Wrench,
  XCircle,
} from "lucide-react";
import type { ProxyHealth } from "@nlo/shared";
import {
  proxyConnectivity,
  proxyCreateFromUri,
  proxyCreateManual,
  proxyDelete,
  proxyGet,
  proxyHealthCheck,
  proxyRuntimeStatus,
  proxyValidate,
  proxiesList,
  proxiesPingAll,
  type MaskedProxyNode,
  type ManualProxyInput,
  type ProxyRuntimeStatus,
} from "@/lib/api";
import { fa } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<MaskedProxyNode | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);
  const [lastPing, setLastPing] = useState<{ at: string; target: string } | null>(null);

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

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await proxyDelete(deleting.id);
      setItems((l) => l?.filter((n) => n.id !== deleting.id) ?? null);
      toast({ title: "نود حذف شد", variant: "success" });
      if (detailId === deleting.id) setDetailId(null);
      setDeleting(null);
    } catch (err) {
      toast({ title: "حذف ناموفق بود", description: errMessage(err), variant: "error" });
    }
  };

  /** Ping every node to notebooklm.google.com:443, then reload the list. */
  const doPingAll = async () => {
    if (!items || items.length === 0) return;
    setPinging(true);
    try {
      const res = await proxiesPingAll();
      const bad = res.results.filter((r) => !r.ok).length;
      setLastPing({ at: res.at, target: res.target });
      toast({
        title: `بررسی ${fa(res.results.length)} نود به مقصد ${res.target} تمام شد`,
        description:
          bad === 0
            ? "همه نودها پاسخ دادند."
            : `${fa(bad)} نود پاسخ ندادند؛ جزئیات را از ستون پینگ ببینید.`,
        variant: bad === 0 ? "success" : "default",
      });
    } catch (err) {
      toast({ title: "بررسی گروهی ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setPinging(false);
      await load();
    }
  };

  /**
   * Display order: nodes that answered last, fastest ping first; nodes that
   * failed (or were never checked) go to the bottom, oldest failures first.
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
            disabled={pinging || !items || items.length === 0}
            onClick={() => void doPingAll()}
          >
            <Activity className={pinging ? "animate-pulse" : undefined} />
            {pinging ? "در حال بررسی همه نودها…" : "تست پینگ همه نودها"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            تازه‌سازی
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus />
            افزودن نود
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
            description="یک URI صحنه‌ی vless:// را وارد کنید تا نود از روی آن ساخته شود."
            action={
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus />
                افزودن نود
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>نود</TableHead>
                <TableHead>سروور</TableHead>
                <TableHead className="text-left tabular-nums">پینگ (NotebookLM)</TableHead>
                <TableHead aria-label="عملیات" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sorted ?? items).map((n) => (
                <TableRow key={n.id} data-state={detailId === n.id ? "selected" : undefined}>
                  <TableCell>
                    <button
                      type="button"
                      className="block max-w-56 cursor-pointer truncate text-start text-sm font-medium hover:underline"
                      title="دیدن جزئیات"
                      onClick={() => setDetailId(detailId === n.id ? null : n.id)}
                    >
                      {n.config.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-xs" dir="ltr">
                    {n.config.server}:{fa(n.config.port)}
                  </TableCell>
                  <TableCell numeric>
                    <PingCell node={n} checking={busyId === n.id} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="تست پینگ"
                        disabled={busyId === n.id}
                        onClick={async () => {
                          setBusyId(n.id);
                          try {
                            const res = await proxyHealthCheck(n.id, { target: "notebooklm" });
                            await load();
                            setDetailId(n.id);
                            toast({
                              title: res.ok
                                ? `پینگ ${fa(res.latencyMs ?? 0)} ms`
                                : "پینگ ناموفق بود",
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
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="ویرایش"
                        onClick={() => setDetailId(n.id)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="حذف"
                        onClick={() => setDeleting(n)}
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

        {detailId && items?.some((n) => n.id === detailId) && (
          <ProxyDetail key={detailId} nodeId={detailId} onHealth={() => void load()} />
        )}
      </CardContent>

      <AddProxyDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(warnings) => {
          void load();
          if (warnings.length > 0) {
            toast({ title: "نود افزوده شد", description: warnings.join("؛ "), variant: "default" });
          } else {
            toast({ title: "نود افزوده شد", variant: "success" });
          }
        }}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="حذف نود"
        description={
          deleting
            ? `نود «${deleting.config.name}» و رمز UUID آن از گاوصندوق حذف می‌شوند. این کار برگشت‌پذیر نیست.`
            : undefined
        }
        confirmText="حذف"
        destructive
        onConfirm={() => void doDelete()}
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

/* ------------------------------- detail panel ------------------------------- */

function ProxyDetail({ nodeId, onHealth }: { nodeId: string; onHealth: () => void }) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<{
    node: MaskedProxyNode;
    health: ProxyHealth;
    history: ProxyHealth[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await proxyGet(nodeId));
    } catch (err) {
      setError(errMessage(err));
    }
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (kind: "validate" | "connectivity" | "health" | "health_nbl") => {
    setBusy(kind);
    try {
      if (kind === "validate") {
        const res = await proxyValidate(nodeId);
        toast({
          title: res.ok ? "پیکربندی معتبر است" : "پیکربندی خطا دارد",
          description: res.issues.join("؛ ") || undefined,
          variant: res.ok ? "success" : "error",
        });
      } else if (kind === "connectivity") {
        const res = await proxyConnectivity(nodeId);
        toast({
          title: res.ok ? "اتصال تونل برقرار شد" : "اتصال تونل برقرار نشد",
          description: res.ok ? `تونل: ${res.handle?.host}:${res.handle?.port}` : res.error,
          variant: res.ok ? "success" : "error",
        });
      } else {
        const res = await proxyHealthCheck(
          nodeId,
          kind === "health_nbl" ? { target: "notebooklm" } : {},
        );
        toast({
          title: res.ok ? "سلامت کامل تأیید شد" : "سلامت تأیید نشد",
          description:
            res.evidence ??
            res.error ??
            (res.egressIp ? `خروجی مشاهده‌شده: ${res.egressIp}` : undefined),
          variant: res.ok ? "success" : "error",
        });
        onHealth();
      }
    } catch (e) {
      toast({ title: "عملیات ناموفق بود", description: errMessage(e), variant: "error" });
    } finally {
      setBusy(null);
      void load();
    }
  };

  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;
  if (!detail) return <Skeleton className="h-24 w-full" />;

  const { node, health, history } = detail;
  const fields: [string, string][] = [
    ["سروور", `${node.config.server}:${node.config.port}`],
    ["UUID (ماسک‌دار)", node.config.uuidMasked],
    ["SNI", node.config.sni ?? "—"],
    ["WS Host", node.config.wsHost ?? "—"],
    ["WS Path", node.config.wsPath ?? "—"],
    ["Flow", node.config.flow ?? "—"],
  ];

  return (
    <div className="mt-4 rounded-surface border-line border-border bg-field/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{node.config.name}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("validate")}
          >
            <Wrench />
            {busy === "validate" ? "در حال بررسی…" : "اعتبارسنجی پیکربندی"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("connectivity")}
          >
            <Wifi />
            {busy === "connectivity" ? "در حال اتصال…" : "تست اتصال"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("health")}
          >
            <RefreshCw className={busy === "health" ? "animate-spin" : undefined} />
            {busy === "health" ? "در حال بررسی…" : "سلامت (امتحان خروج)"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void run("health_nbl")}
          >
            <RefreshCw className={busy === "health_nbl" ? "animate-spin" : undefined} />
            {busy === "health_nbl" ? "در حال بررسی…" : "سلامت (مقصد NotebookLM)"}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          {fields.map(([k, v]) => (
            <div
              key={k}
              className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5"
            >
              <span className="text-muted-foreground">{k}</span>
              <span className="max-w-40 truncate" dir="ltr">
                {v}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 text-xs">
          <p className="font-medium">آخرین بررسی سلامت</p>
          {health.lastCheckedAt ? (
            <>
              <div className="flex items-center gap-2">
                {health.ok ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : (
                  <XCircle className="size-4 text-destructive" />
                )}
                <span>{health.ok ? "سالم" : "ناموفق"}</span>
                <span className="text-muted-foreground">
                  <RelativeTime iso={health.lastCheckedAt} />
                </span>
              </div>
              {health.egressIp && (
                <p className="text-muted-foreground" dir="ltr">
                  egress: {health.egressIp}
                </p>
              )}
              {health.latencyMs !== null && (
                <p className="text-muted-foreground">تأخیر: {fa(health.latencyMs)} ms</p>
              )}
              {health.target && (
                <p className="text-muted-foreground">
                  مقصد امتحان: <span dir="ltr">{health.target}</span>
                </p>
              )}
              {health.evidence && (
                <p
                  className={`max-h-28 overflow-auto whitespace-pre-wrap rounded-field border-border bg-field p-2 ${
                    health.ok ? "text-muted-foreground" : "text-destructive"
                  }`}
                >
                  {health.evidence}
                </p>
              )}
              {health.error && <p className="text-destructive">{health.error}</p>}
            </>
          ) : (
            <p className="text-muted-foreground">هنوز بررسی نشده است.</p>
          )}
          {history.length > 0 && (
            <p className="text-muted-foreground">{fa(history.length)} بررسی در تاریخچه</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- add dialog -------------------------------- */

function AddProxyDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: (warnings: string[]) => void;
}) {
  const [tab, setTab] = useState("uri");
  const [uri, setUri] = useState("");
  const [priority, setPriority] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [manual, setManual] = useState<ManualProxyInput & { server: string }>({
    name: "",
    server: "",
    port: 443,
    uuid: "",
    transport: "tcp",
    security: "none",
  });

  const setM = <K extends keyof ManualProxyInput>(k: K, v: ManualProxyInput[K]) =>
    setManual((m) => ({ ...m, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (tab === "uri") {
        if (!uri.trim()) {
          setErr("URI صحنه‌ای vless:// الزامی است.");
          return;
        }
        const res = await proxyCreateFromUri({
          uri: uri.trim(),
          priority: priority ? Number(priority) : undefined,
        });
        onAdded(res.warnings ?? []);
      } else {
        if (!manual.name.trim() || !manual.server.trim() || !manual.uuid.trim()) {
          setErr("نام، سروور و UUID الزامی‌اند.");
          return;
        }
        await proxyCreateManual({ ...manual, priority: priority ? Number(priority) : undefined });
        onAdded([]);
      }
      setUri("");
      setPriority("");
      setManual({ name: "", server: "", port: 443, uuid: "", transport: "tcp", security: "none" });
      onOpenChange(false);
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
      title="نود VLESS جدید"
      description="URI صحنه‌ای توصیه می‌شود؛ UUID مستقیم وارد گاوصندوق می‌شود و هرگز در جدول داده ذخیره نمی‌شود."
      footer={
        <>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "در حال افزودن…" : "افزودن"}
          </Button>
          <Button variant="outline" data-autofocus onClick={() => onOpenChange(false)}>
            انصراف
          </Button>
        </>
      }
    >
      <Tabs defaultValue="uri" value={tab} onValueChange={setTab} className="w-full">
        <TabsList aria-label="روش افزودن">
          <TabsTrigger value="uri">URI صحنه‌ای</TabsTrigger>
          <TabsTrigger value="manual">دستی</TabsTrigger>
        </TabsList>

        <TabsContent value="uri">
          <div className="flex flex-col gap-4">
            <Field
              label="URI صحنه‌ای"
              htmlFor="p-uri"
              hint="vless://… — رمز UUID از آن استخراج و در گاوصندوق نگهداری می‌شود."
            >
              <Input
                id="p-uri"
                dir="ltr"
                placeholder="vless://uuid@host:443?security=reality&…"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                error={err ?? undefined}
              />
            </Field>
          </div>
        </TabsContent>

        <TabsContent value="manual">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="نام" htmlFor="p-name">
              <Input
                id="p-name"
                value={manual.name}
                onChange={(e) => setM("name", e.target.value)}
                error={err ?? undefined}
              />
            </Field>
            <Field label="سروور" htmlFor="p-server">
              <Input
                id="p-server"
                dir="ltr"
                value={manual.server}
                onChange={(e) => setM("server", e.target.value)}
              />
            </Field>
            <Field label="پورت" htmlFor="p-port">
              <Input
                id="p-port"
                type="number"
                dir="ltr"
                min={1}
                max={65535}
                value={manual.port}
                onChange={(e) => setM("port", Number(e.target.value))}
              />
            </Field>
            <Field label="UUID" htmlFor="p-uuid">
              <Input
                id="p-uuid"
                dir="ltr"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={manual.uuid}
                onChange={(e) => setM("uuid", e.target.value)}
              />
            </Field>
          </div>
        </TabsContent>
      </Tabs>

      <div className="mt-4">
        <Field label="اولویت (اختیاری)" htmlFor="p-priority" hint="عدد کمتر = اولویت بالاتر.">
          <Input
            id="p-priority"
            type="number"
            dir="ltr"
            min={0}
            max={10000}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "خطای نامشخص";
}
