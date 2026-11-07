import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Layers, Upload, X } from "lucide-react";
import {
  ALLOWED_SOURCE_EXTENSIONS,
  MAX_SOURCES_PER_JOB,
  sourceKindOf,
  type SourceKind,
} from "@nlo/shared";
import { jobCreate } from "@/lib/api";
import { fa, faFileSize } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";

/** 100 MB per file — NotebookLM's per-source limit (mirrored server-side). */
const MAX_UPLOAD = 100 * 1024 * 1024;
/** Client-side prompt cap mirroring the server limit (previously a runtime setting). */
const MAX_PROMPT_CHARS = 20_000;

const ACCEPT = ALLOWED_SOURCE_EXTENSIONS.map((e) => `.${e}`).join(",");

const KIND_LABEL: Record<SourceKind, string> = {
  document: "اسناد",
  text: "متن",
  ebook: "کتاب الکترونیکی",
  image: "تصویر",
  audio: "صوت",
  video: "ویدیو",
};

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * درخواست جدید — a multipart form (prompt + 0..N files of any NotebookLM
 * format). The Google account and the egress proxy are chosen automatically
 * by the server (default account, healthiest enabled proxy); there is no
 * per-job selection. Everything is validated client-side first, and the
 * provider's own validation runs server-side on the job.
 */
export function CreateJobPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const addFiles = (incoming: FileList | File[]) => {
    setFileError(null);
    const list = Array.from(incoming);
    setFiles((prev) => {
      const merged = [...prev, ...list];
      if (merged.length > MAX_SOURCES_PER_JOB) {
        setFileError(`حداکثر ${fa(MAX_SOURCES_PER_JOB)} فایل می‌توانید انتخاب کنید.`);
        return merged.slice(0, MAX_SOURCES_PER_JOB);
      }
      return merged;
    });
    for (const f of list) {
      const ext = extOf(f.name);
      if (!ALLOWED_SOURCE_EXTENSIONS.includes(ext as (typeof ALLOWED_SOURCE_EXTENSIONS)[number])) {
        setFileError(`فرمت فایل «${f.name}» پشتیبانی نمی‌شود.`);
      } else if (f.size > MAX_UPLOAD) {
        setFileError(`حجم فایل «${f.name}» بیشتر از سقف ${faFileSize(MAX_UPLOAD)} است.`);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const removeFile = (idx: number) => {
    setFileError(null);
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSubmit =
    prompt.trim().length > 0 && !submitting && files.every((f) => f.size <= MAX_UPLOAD);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await jobCreate({
        title: title.trim() || undefined,
        prompt: prompt.trim(),
        files,
      });
      toast({
        title: "درخواست ایجاد شد",
        description: "در صف پردازش قرار گرفت.",
        variant: "success",
      });
      navigate(`/jobs/${res.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "ایجاد درخواست ناموفق بود.");
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>درخواست پردازش جدید</CardTitle>
          <CardDescription>
            یک یا چند فایل (هر فرمتی که NotebookLM بپذیرد) و سؤالی که می‌خواهید درباره‌اش پاسخ
            بگیرید را انتخاب کنید. اعتبارسنجی نهایی توسط ارائه‌دهنده روی سرور انجام می‌شود.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-5">
            <Field label="عنوان (اختیاری)" htmlFor="title">
              <Input
                id="title"
                placeholder="مثلاً: خلاصه‌ی پادکست شماره ۱۲"
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label="سؤال / دستور" htmlFor="prompt">
              <Textarea
                id="prompt"
                rows={5}
                maxLength={MAX_PROMPT_CHARS}
                showCount
                placeholder="مثلا‌ً: خلاصه‌ی این گفت‌وگو را در پنج نکته بنویس…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground/90">
                فایل‌ها (اختیاری، تا {fa(files.length)} از {fa(MAX_SOURCES_PER_JOB)})
              </span>
              {files.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {files.map((f, i) => {
                    const kind = sourceKindOf(extOf(f.name));
                    return (
                      <li
                        key={`${f.name}-${i}`}
                        className="flex items-center gap-3 rounded-field border-line border-border bg-field px-3 py-2"
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm" dir="ltr">
                            {f.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {faFileSize(f.size)}
                            {kind ? ` · ${KIND_LABEL[kind]}` : ""}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="حذف فایل"
                          type="button"
                          onClick={() => removeFile(i)}
                        >
                          <X />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <label
                htmlFor="sources"
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-field border border-dashed border-input bg-field/40 px-4 py-8 text-center transition-colors hover:bg-field"
              >
                <Layers className="size-6 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {files.length > 0 ? "افزودن فایل دیگر" : "انتخاب فایل (یکی یا چند)"}
                </span>
                <span className="text-xs text-muted-foreground">
                  PDF، Word، PowerPoint، CSV، متن، EPUB، تصویر، صدا — تا {faFileSize(MAX_UPLOAD)}{" "}
                  برای هر فایل
                </span>
              </label>
              <input
                ref={fileRef}
                id="sources"
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
                }}
              />
              {fileError && (
                <p role="alert" className="text-xs text-destructive">
                  {fileError}
                </p>
              )}
            </div>

            {submitError && (
              <p
                role="alert"
                className="rounded-field border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {submitError}
              </p>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canSubmit}>
                <Upload />
                {submitting ? "در حال ارسال…" : "ایجاد درخواست"}
              </Button>
              <Link to="/jobs">
                <Button variant="ghost" type="button">
                  انصراف
                </Button>
              </Link>
              <Badge variant="secondary" className="ms-auto">
                پردازش روی سرور، نه در مرورگر
              </Badge>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
