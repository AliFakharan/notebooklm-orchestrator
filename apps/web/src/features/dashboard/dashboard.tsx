import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PlusCircle, Radio } from "lucide-react";
import type { JobStatus } from "@nlo/shared";
import { jobsList } from "@/lib/api";
import { fa } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Stat } from "@/components/ui/stat";
import { Button } from "@/components/ui/button";
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
}

/**
 * نمای کلی — the operator's at-a-glance page: job counts by state and the
 * most recent requests. Infrastructure (accounts/proxies) is admin-only and
 * intentionally never shown here — it lives behind /admin.
 */
export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [all, inflight, attention] = await Promise.allSettled([
        jobsList({ limit: 8 }),
        jobsList({ status: INFLIGHT, limit: 200 }),
        jobsList({ status: ["NEEDS_ATTENTION"], limit: 200 }),
      ]);
      const first = (r: PromiseSettledResult<unknown>): unknown =>
        r.status === "fulfilled" ? r.value : null;
      setData({
        total: (first(all) as { total: number } | null)?.total ?? 0,
        items: (first(all) as { items: DashboardData["items"] } | null)?.items ?? [],
        inFlight: (first(inflight) as { total: number } | null)?.total ?? 0,
        attention: (first(attention) as { total: number } | null)?.total ?? 0,
      });
      if (all.status === "rejected") {
        setError(all.reason instanceof Error ? all.reason.message : "بارگذاری نشد.");
      }
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {loading || !data ? (
          Array.from({ length: 2 }).map((_, i) => <StatSkeleton key={i} />)
        ) : (
          <>
            <Stat label="درخواست‌های در حال پردازش" value={fa(data.inFlight)} />
            <Stat label="نیازمند بررسی" value={fa(data.attention)} />
          </>
        )}
      </div>

      {error && <ErrorBanner message={error} onRetry={() => void load()} />}

      <div className="grid gap-4">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader className="items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
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
                    <TableHead className="hidden sm:table-cell">پیشرفت</TableHead>
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
                      <TableCell numeric className="hidden text-xs text-muted-foreground sm:table-cell">
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
      </div>

      {data && stats && (stats.succeeded > 0 || stats.failed > 0) && (
        <p className="text-xs text-muted-foreground">
          در {fa(data.items.length)} مورد اخیر: {fa(stats.succeeded)} موفق، {fa(stats.failed)}{" "}
          ناموفق.
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
