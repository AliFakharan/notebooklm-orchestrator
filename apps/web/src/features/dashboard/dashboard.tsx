import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Cable, PlusCircle, Radio } from "lucide-react";
import type { JobStatus } from "@nlo/shared";
import { accountsList, jobsList, proxiesList, type MaskedProxyNode } from "@/lib/api";
import { fa, faFileSize } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton, SkeletonRow } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorBanner } from "@/components/shared/error-banner";
import { JobStatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";

const INFLIGHT: JobStatus[] = [
  "CREATED",
  "VALIDATING",
  "QUEUED",
  "WAITING_FOR_ACCOUNT",
  "WAITING_FOR_PROXY",
  "RUNNING",
  "RETRY_WAIT",
  "CANCEL_REQUESTED",
];

interface DashboardData {
  total: number;
  items: Awaited<ReturnType<typeof jobsList>>["items"];
  inFlight: number;
  attention: number;
  accountsTotal: number;
  accountsReady: number;
  proxiesTotal: number;
  proxies: MaskedProxyNode[];
}

/**
 * نمای کلی — the operator's at-a-glance page: job counts by state, the most
 * recent requests, and the readiness of accounts and proxy nodes.
 */
export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [all, inflight, attention, accounts, proxies] = await Promise.all([
        jobsList({ limit: 8 }),
        jobsList({ status: INFLIGHT, limit: 200 }),
        jobsList({ status: ["NEEDS_ATTENTION"], limit: 200 }),
        accountsList(),
        proxiesList(),
      ]);
      setData({
        total: all.total,
        items: all.items,
        inFlight: inflight.total,
        attention: attention.total,
        accountsTotal: accounts.length,
        accountsReady: accounts.filter((a) => a.status === "ACTIVE" && a.enabled).length,
        proxiesTotal: proxies.length,
        proxies,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "بارگذاری نشد.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    if (!data) return null;
    const succeeded = data.items.filter((j) => j.status === "SUCCEEDED").length;
    const failed = data.items.filter((j) => j.status === "FAILED").length;
    return { succeeded, failed };
  }, [data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <StatSkeleton key={i} />)
        ) : (
          <>
            <Stat label="درخواست‌های در حال پردازش" value={fa(data.inFlight)} />
            <Stat label="نیازمند بررسی" value={fa(data.attention)} />
            <Stat
              label="حساب‌های آماده"
              value={fa(data.accountsReady)}
              unit={`از ${fa(data.accountsTotal)}`}
            />
            <Stat label="پراکسی‌ها" value={fa(data.proxiesTotal)} />
          </>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>درخواست‌های اخیر</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/jobs">
                <Button variant="ghost" size="sm">
                  <Radio />
                  همه
                </Button>
              </Link>
              <Link to="/new">
                <Button size="sm">
                  <PlusCircle />
                  درخواست جدید
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <SkeletonRow key={i} shimmer />
                ))}
              </div>
            ) : !data || data.items.length === 0 ? (
              <EmptyState
                icon={<Radio className="size-8" />}
                title="هنوز درخواستی ثبت نشده"
                description="اولین درخواست پردازش را با یک فایل صوتی و یک سؤالی که می‌خواهید از آن بپرسید، ایجاد کنید."
                action={
                  <Link to="/new">
                    <Button size="sm">
                      <PlusCircle />
                      ایجاد درخواست
                    </Button>
                  </Link>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>درخواست</TableHead>
                    <TableHead>وضعیت</TableHead>
                    <TableHead>پیشرفت</TableHead>
                    <TableHead>تاریخ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <Link to={`/jobs/${job.id}`} className="group block min-w-0">
                          <p className="truncate text-sm font-medium group-hover:underline">
                            {job.input.title ??
                              (job.input.prompt.length > 60
                                ? `${job.input.prompt.slice(0, 60)}…`
                                : job.input.prompt)}
                          </p>
                          <p className="truncate text-xs text-muted-foreground" dir="ltr">
                            {job.id}
                          </p>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <JobStatusBadge status={job.status} />
                      </TableCell>
                      <TableCell numeric className="text-xs text-muted-foreground">
                        {job.progress > 0 ? fa(job.progress) + "٪" : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <RelativeTime iso={job.updatedAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>زیرساخت</CardTitle>
            <Link to="/proxies">
              <Button variant="ghost" size="sm">
                <Cable />
                پراکسی‌ها
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {loading || !data ? (
              <div className="flex flex-col gap-2">
                <SkeletonRow shimmer />
                <SkeletonRow shimmer />
              </div>
            ) : (
              <>
                <p className="text-xs leading-6 text-muted-foreground">
                  {data.accountsTotal === 0
                    ? "حسابی ثبت نشده است؛ برای پردازش حداقل یک حساب لازم است."
                    : `${fa(data.accountsReady)} از ${fa(data.accountsTotal)} حساب آماده‌ی پردازش است.`}
                </p>
                {data.proxies.length === 0 ? (
                  <EmptyState
                    icon={<Cable className="size-6" />}
                    title="پراکسی‌ای تعریف نشده"
                    description="نودهای VLESS را با URI وارد کنید تا از خروجی محافظت‌شده استفاده شود."
                  />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {data.proxies.slice(0, 4).map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">{p.config.name}</span>
                        <Badge variant={p.enabled ? "success" : "secondary"}>
                          {p.enabled ? "فعال" : "غیرفعال"}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {data && stats && (stats.succeeded > 0 || stats.failed > 0) && (
        <p className="text-xs text-muted-foreground">
          در {fa(data.items.length)} مورد اخیر: {fa(stats.succeeded)} موفق، {fa(stats.failed)}{" "}
          ناموفق. حجم فایل‌های بارگذاری‌شده تا سقف {faFileSize(200 * 1024 * 1024)}.
        </p>
      )}
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 h-7 w-16" />
    </div>
  );
}
