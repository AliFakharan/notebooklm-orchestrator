import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Ban,
  Download,
  FileAudio,
  ListOrdered,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  ScrollText,
} from "lucide-react";
import type { Artifact, Job, JobEvent } from "@nlo/shared";
import {
  artifactDownload,
  jobAttempts,
  jobArtifacts,
  jobCancel,
  jobEvents,
  jobGet,
  jobRequeue,
  FAILURE_CLASS_LABELS,
  type JobAttempt,
} from "@/lib/api";
import { fa, faFileSize } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { ErrorBanner } from "@/components/shared/error-banner";
import { JobStatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * جزئیات درخواست — full job record: identity, progress, actions (cancel /
 * re-queue), and tabs for the answer, event timeline, attempts and
 * artifacts. Non-terminal jobs poll until they settle.
 */
export function JobDetailsPage() {
  const { id = "" } = useParams();
  const { toast } = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setJob(await jobGet(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "بارگذاری نشد.");
    }
  }, [id]);

  useEffect(() => {
    setJob(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!job || TERMINAL.has(job.status)) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [job, load]);

  const doCancel = async () => {
    if (!job) return;
    setCancelBusy(true);
    try {
      await jobCancel(job.id);
      toast({ title: "درخواست لغو شد", variant: "success" });
      await load();
    } catch (err) {
      toast({ title: "لغو ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setCancelBusy(false);
    }
  };

  const doRequeue = async () => {
    if (!job) return;
    try {
      await jobRequeue(job.id);
      toast({ title: "در صف قرار گرفت", variant: "success" });
      await load();
    } catch (err) {
      toast({ title: "عملیات ناموفق بود", description: errMessage(err), variant: "error" });
    }
  };

  if (error) {
    return <ErrorBanner message={error} onRetry={() => void load()} />;
  }

  if (!job) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 p-6">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  const cancellable = !TERMINAL.has(job.status) && job.status !== "CANCEL_REQUESTED";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <JobStatusBadge status={job.status} />
              <span className="text-xs text-muted-foreground" dir="ltr">
                {job.id}
              </span>
              {job.errorClass && (
                <Badge variant="destructive">{FAILURE_CLASS_LABELS[job.errorClass]}</Badge>
              )}
            </div>
            <h2 className="mt-2 text-base font-semibold leading-7">{job.input.prompt}</h2>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>
                ساخته‌شده: <RelativeTime iso={job.createdAt} />
              </span>
              {job.finishedAt && (
                <span>
                  پایان: <RelativeTime iso={job.finishedAt} />
                </span>
              )}
              <span>
                تلاش: {fa(job.attempt)} از {fa(job.maxAttempts)}
              </span>
              {job.nodeId && <span dir="ltr">node: {job.nodeId.slice(0, 8)}</span>}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {cancellable && (
              <Button
                variant="outline"
                size="sm"
                disabled={cancelBusy}
                onClick={() => {
                  if (window.confirm("این درخواست لغو شود؟")) void doCancel();
                }}
              >
                <Ban />
                {job.status === "RUNNING" ? "لغو (در پایان تلاش)" : "لغو درخواست"}
              </Button>
            )}
            {job.status === "NEEDS_ATTENTION" && (
              <Button size="sm" onClick={() => void doRequeue()}>
                <RotateCcw />
                در صف دوباره
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Progress value={job.progress} label="پیشرفت" showValue size="sm" />
          {job.progressNote && <p className="text-xs text-muted-foreground">{job.progressNote}</p>}
          {job.status === "FAILED" && job.errorMessage && (
            <p
              role="alert"
              className="rounded-field border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {job.errorMessage}
            </p>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="answer">
        <TabsList aria-label="بخش‌های درخواست">
          <TabsTrigger value="answer">
            <span className="inline-flex items-center gap-1.5">
              <MessageSquareText className="size-4" />
              پاسخ
            </span>
          </TabsTrigger>
          <TabsTrigger value="events">
            <span className="inline-flex items-center gap-1.5">
              <ScrollText className="size-4" />
              رویدادها
            </span>
          </TabsTrigger>
          <TabsTrigger value="attempts">
            <span className="inline-flex items-center gap-1.5">
              <ListOrdered className="size-4" />
              تلاش‌ها
            </span>
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            <span className="inline-flex items-center gap-1.5">
              <FileAudio className="size-4" />
              فایل‌ها
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="answer" className="mt-4">
          <AnswerPanel job={job} />
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          <EventsPanel jobId={job.id} />
        </TabsContent>
        <TabsContent value="attempts" className="mt-4">
          <AttemptsPanel jobId={job.id} />
        </TabsContent>
        <TabsContent value="artifacts" className="mt-4">
          <ArtifactsPanel job={job} />
        </TabsContent>
      </Tabs>

      <p className="text-xs text-muted-foreground">
        <Link to="/jobs" className="hover:underline">
          بازگشت به فهرست درخواست‌ها
        </Link>
      </p>
    </div>
  );
}

/* --------------------------------- panels --------------------------------- */

function AnswerPanel({ job }: { job: Job }) {
  if (!job.answerMarkdown) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          هنوز پاسخی ثبت نشده است.{" "}
          {job.status === "SUCCEEDED" ? "" : "پس از پایان با موفقیت، پاسخ اینجا نمایش داده می‌شود."}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>پاسخ</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Markdown is rendered as plain text: no sanitization pipeline is
            bundled, and echoing untrusted HTML would be an XSS risk. */}
        <pre className="max-h-120 overflow-auto whitespace-pre-wrap rounded-field border-line border-border bg-field p-4 text-sm leading-8">
          {job.answerMarkdown}
        </pre>
        {job.resultProviderMeta && (
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">جزئیات ارائه‌دهنده</summary>
            <pre
              className="mt-2 overflow-auto rounded-field border-line border-border bg-field p-3"
              dir="ltr"
            >
              {JSON.stringify(job.resultProviderMeta, null, 2)}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function EventsPanel({ jobId }: { jobId: string }) {
  const [events, setEvents] = useState<JobEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEvents(await jobEvents(jobId));
    } catch (err) {
      setError(errMessage(err));
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;
  if (!events)
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  if (events.length === 0)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          رویدادی ثبت نشده است.
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>خط زمان رویدادها</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col">
          {events.map((ev) => (
            <li key={ev.id} className="flex gap-3 border-b border-border py-2.5 last:border-0">
              <div className="w-40 shrink-0 text-xs text-muted-foreground">
                <RelativeTime iso={ev.at} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium" dir="ltr">
                  {ev.type}
                </p>
                {ev.message && <p className="text-xs text-muted-foreground">{ev.message}</p>}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function AttemptsPanel({ jobId }: { jobId: string }) {
  const [attempts, setAttempts] = useState<JobAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAttempts(await jobAttempts(jobId));
    } catch (err) {
      setError(errMessage(err));
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;
  if (!attempts)
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  if (attempts.length === 0)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          هنوز تلاشی ثبت نشده است.
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>تلاش‌های پردازش</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-3">
          {attempts.map((a) => (
            <li key={a.attempt} className="rounded-field border-line border-border bg-field/40 p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <Badge
                  variant={
                    a.outcome === "succeeded"
                      ? "success"
                      : a.outcome === "running"
                        ? "brand"
                        : "destructive"
                  }
                >
                  {a.outcome}
                </Badge>
                <span>تلاش {fa(a.attempt)}</span>
                <span>
                  شروع: <RelativeTime iso={a.startedAt} />
                </span>
                {a.endedAt && (
                  <span>
                    پایان: <RelativeTime iso={a.endedAt} />
                  </span>
                )}
              </div>
              {Object.keys(a.detail).length > 0 && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">جزئیات</summary>
                  <pre
                    className="mt-2 overflow-auto rounded-field border-line border-border bg-field p-3"
                    dir="ltr"
                  >
                    {JSON.stringify(a.detail, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function ArtifactsPanel({ job }: { job: Job }) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const urls = useRef(new Set<string>());
  const { toast } = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await jobArtifacts(job.id));
    } catch (err) {
      setError(errMessage(err));
    }
  }, [job.id]);

  useEffect(() => {
    void load();
    return () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current.clear();
    };
  }, [load]);

  const download = async (art: Artifact) => {
    setBusyId(art.id);
    try {
      const url = await artifactDownload(job.id, art.id);
      urls.current.add(url);
      const a = document.createElement("a");
      a.href = url;
      a.download = art.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      toast({ title: "دریافت فایل ناموفق بود", description: errMessage(err), variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;
  if (!items)
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  if (items.length === 0)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          برای این درخواست فایلی ثبت نشده است.
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>فایل‌ها</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {items.map((art) => (
            <li
              key={art.id}
              className="flex items-center gap-3 rounded-field border-line border-border bg-field/40 px-3 py-2.5"
            >
              <FileAudio className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" dir="ltr">
                  {art.filename}
                </p>
                <p className="text-xs text-muted-foreground">
                  {faFileSize(art.size)} ·{" "}
                  {art.source === "provider" ? "از ارائه‌دهنده" : "ساخته‌شده در اپلیکیشن"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busyId === art.id}
                onClick={() => void download(art)}
              >
                {busyId === art.id ? <RefreshCw className="animate-spin" /> : <Download />}
                دانلود
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "خطای نامشخص";
}
