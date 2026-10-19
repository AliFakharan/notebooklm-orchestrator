import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PlusCircle, RefreshCw, Search } from "lucide-react";
import type { Job, JobStatus } from "@nlo/shared";
import { jobsList, JOB_STATUS_LABELS } from "@/lib/api";
import { fa } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
import { JobStatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";

const PAGE_SIZE = 25;

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "همه‌ی وضعیت‌ها" },
  ...(Object.entries(JOB_STATUS_LABELS) as [JobStatus, string][]).map(([v, l]) => ({
    value: v,
    label: l,
  })),
];

/**
 * تاریخچه‌ی درخواست‌ها — filterable, paginated list. Live rows (non-terminal
 * statuses) refresh on an interval so the page tracks progress without a
 * manual reload.
 */
export function JobHistoryPage() {
  const [items, setItems] = useState<Job[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await jobsList({
        status: status ? [status as JobStatus] : undefined,
        search: search.trim() || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "بارگذاری نشد.");
    }
  }, [status, search, page]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  // Refresh while any visible row is still in flight.
  useEffect(() => {
    if (!items?.some((j) => !["SUCCEEDED", "FAILED", "CANCELLED"].includes(j.status))) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [items, load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="جست‌وجو در درخواست‌ها"
              placeholder="جست‌وجو در سؤالات…"
              className="ps-9"
              value={search}
              onChange={(e) => {
                setPage(0);
                setSearch(e.target.value);
              }}
            />
          </div>
          <div className="w-48">
            <Select
              aria-label="فیلتر وضعیت"
              value={status}
              onChange={(e) => {
                setPage(0);
                setStatus(e.target.value);
              }}
              options={STATUS_FILTERS}
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            تازه‌سازی
          </Button>
          <Link to="/new">
            <Button size="sm">
              <PlusCircle />
              درخواست جدید
            </Button>
          </Link>
        </div>

        {error && <ErrorBanner message={error} onRetry={() => void load()} />}

        {!items ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} shimmer />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Search className="size-8" />}
            title="درخواستی یافت نشد"
            description="فیلترها یا عبارت جست‌وجو را تغییر دهید."
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>درخواست</TableHead>
                  <TableHead>وضعیت</TableHead>
                  <TableHead>پیشرفت</TableHead>
                  <TableHead>تلاش</TableHead>
                  <TableHead>بازگشت</TableHead>
                  <TableHead>به‌روزرسانی</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Link to={`/jobs/${job.id}`} className="group block min-w-0">
                        <p className="max-w-md truncate text-sm font-medium group-hover:underline">
                          {(() => {
                            const t = job.input.title;
                            if (t) return t;
                            const p = job.input.prompt;
                            return p.length > 80 ? `${p.slice(0, 80)}…` : p;
                          })()}
                        </p>
                        <p className="text-xs text-muted-foreground" dir="ltr">
                          {job.id}
                        </p>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell numeric className="text-xs">
                      {job.progress > 0 ? (
                        <span className="tabular-nums">{fa(job.progress)}٪</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell numeric className="text-xs text-muted-foreground">
                      {fa(job.attempt)}/{fa(job.maxAttempts)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground" dir="ltr">
                      {job.nodeId ? job.nodeId.slice(0, 8) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <RelativeTime iso={job.updatedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{fa(total)} درخواست در مجموع</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  قبلی
                </Button>
                <span className="tabular-nums">
                  صفحه {fa(page + 1)} از {fa(pages)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pages - 1}
                  onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                >
                  بعدی
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
