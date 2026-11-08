import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { apiKeyCreate, apiKeyRevoke, apiKeysList, type ApiKeyInfo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
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
import { RelativeTime } from "@/components/shared/relative-time";
import { useToast } from "@/components/ui/toast";

/**
 * کلیدهای API — keys for machine-to-machine access to the job surface
 * (e.g. litellm). The raw key is returned exactly once, at creation;
 * afterwards only the masked prefix is available.
 */
export function AdminApiKeysPage() {
  const { toast } = useToast();
  const [items, setItems] = useState<ApiKeyInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The raw key, shown exactly once after a successful create.
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await apiKeysList());
    } catch (err) {
      setError(errMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trimmed = name.trim();
  const canCreate = trimmed.length >= 1 && trimmed.length <= 64;

  const doCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const k = await apiKeyCreate(trimmed);
      setCreated(k.key);
      setCopied(false);
      setName("");
      toast({
        title: "کلید ساخته شد",
        description: "کلید فقط همین‌جا یک‌بار نمایش داده می‌شود؛ آن را در جایی امن ذخیره کن.",
        variant: "success",
      });
      void load();
    } catch (err) {
      toast({ title: "ساخت کلید ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setCreating(false);
    }
  };

  const copyKey = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — ignore */
    }
  };

  const doRevoke = async (k: ApiKeyInfo) => {
    if (
      !window.confirm(
        `کلید «${k.name}» برای همیشه لغو می‌شود و دیگر قابل استفاده نیست. مطمئن هستید؟`,
      )
    )
      return;
    setBusyId(k.id);
    try {
      await apiKeyRevoke(k.id);
      toast({ title: "کلید لغو شد", variant: "success" });
      void load();
    } catch (err) {
      toast({ title: "لغو کلید ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>کلیدهای API</CardTitle>
            <CardDescription>
              کلیدها برای دسترسی برنامه‌های دیگر (مثلاً litellm) به سطح درخواست‌ها ساخته می‌شوند.{" "}
              <a
                href="/documentation"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-brand underline-offset-4 hover:underline"
              >
                مستندات کامل API
                <ExternalLink className="size-3" />
              </a>
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            تازه‌سازی
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={(e) => void doCreate(e)} className="flex flex-row items-end gap-2">
          <Field
            label="نام کلید"
            htmlFor="apikey-name"
            hint="مثلاً: litellm"
            className="min-w-40 flex-1"
          >
            <Input
              id="apikey-name"
              dir="ltr"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="litellm"
              maxLength={64}
              disabled={creating}
            />
          </Field>
          <Button type="submit" disabled={creating || !canCreate}>
            <Plus />
            {creating ? "در حال ساخت…" : "ساخت کلید"}
          </Button>
        </form>

        {created && (
          <div className="flex flex-col gap-2 rounded-surface border border-warning/50 bg-warning/10 p-4">
            <p className="text-xs font-medium text-warning">
              این کلید فقط همین‌جا، یک‌بار نمایش داده می‌شود — الان کپی‌اش کن.
            </p>
            <div className="flex items-center gap-2" dir="ltr">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-background/60 px-3 py-2 font-mono text-sm">
                {created}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void copyKey()}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "کپی شد" : "کپی"}
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <ErrorBanner message={error} onRetry={() => void load()} />
        ) : !items ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} shimmer />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<KeyRound className="size-8" />}
            title="هنوز کلیدی ساخته نشده"
            description="برای اتصال برنامه‌های دیگر به API، کلید اول را بالای همین صفحه بسازید."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>نام</TableHead>
                <TableHead>پیشوند</TableHead>
                <TableHead>ساخته‌شده</TableHead>
                <TableHead>آخرین استفاده</TableHead>
                <TableHead>وضعیت</TableHead>
                <TableHead aria-label="عملیات" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>
                    <p className="text-sm font-medium">{k.name}</p>
                  </TableCell>
                  <TableCell>
                    <code dir="ltr" className="font-mono text-xs text-muted-foreground">
                      {k.prefix}
                    </code>
                  </TableCell>
                  <TableCell>
                    <RelativeTime iso={k.createdAt} />
                  </TableCell>
                  <TableCell>
                    <RelativeTime iso={k.lastUsedAt} />
                  </TableCell>
                  <TableCell>
                    {k.revokedAt ? (
                      <Badge variant="secondary">لغوشده</Badge>
                    ) : (
                      <Badge variant="success">فعال</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {k.revokedAt ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={busyId === k.id}
                        onClick={() => void doRevoke(k)}
                      >
                        <Trash2 />
                        {busyId === k.id ? "در حال لغو…" : "لغو"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "خطای نامشخص";
}
