import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import { Ban, Check, Copy, RotateCcw } from "lucide-react";
import type { Job } from "@nlo/shared";
import { jobCancel, jobGet, jobRequeue, FAILURE_CLASS_LABELS } from "@/lib/api";
import { fa } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ErrorBanner } from "@/components/shared/error-banner";
import { JobStatusBadge } from "@/components/shared/status-badge";
import { RelativeTime } from "@/components/shared/relative-time";

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/**
 * جزئیات درخواست — job identity, progress, the uploaded sources, actions
 * (cancel / re-queue) and the answer. Non-terminal jobs poll until they
 * settle.
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
            <h2 className="mt-2 text-base font-semibold leading-7">
              {job.input.title ?? job.input.prompt}
            </h2>
            {job.input.title && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {job.input.prompt}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>
                ساخته‌شده: <RelativeTime iso={job.createdAt} />
              </span>
              {job.finishedAt && (
                <span>
                  پایان: <RelativeTime iso={job.finishedAt} />
                </span>
              )}
              <span title="تلاش‌های خودکار رانر (بدون دخالت شما)؛ با «بازتلاش» این شمارش از نو شروع می‌شود">
                تلاش خودکار: {fa(job.attempt)} از {fa(job.maxAttempts)}
              </span>
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
            {job.status === "FAILED" && (
              <Button
                size="sm"
                onClick={() => void doRequeue()}
                title="با همان حساب و اطلاعات دوباره وارد صف می‌شود؛ پراکسی تازه انتخاب خواهد شد"
              >
                <RotateCcw />
                بازتلاش
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

      <AnswerPanel job={job} />

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
  const [copied, setCopied] = useState(false);
  if (!job.answerMarkdown) {
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground">
          هنوز پاسخی ثبت نشده است.{" "}
          {job.status === "SUCCEEDED" ? "" : "پس از پایان با موفقیت، پاسخ اینجا نمایش داده می‌شود."}
        </div>
      </Card>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(job.answerMarkdown ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — ignore */
    }
  };
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>پاسخ</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void copy()}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "کپی شد" : "کپی پاسخ"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* react-markdown compiles to React elements (no dangerouslySetInnerHTML),
            so raw HTML in the answer cannot inject — XSS-safe by construction. */}
        <div className="answer-md max-h-120 overflow-auto rounded-field border-line border-border bg-field p-4 text-sm leading-7">
          <ReactMarkdown>{job.answerMarkdown}</ReactMarkdown>
        </div>
      </CardContent>
    </Card>
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "خطای نامشخص";
}
