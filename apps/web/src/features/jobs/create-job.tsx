import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AudioLines, FileAudio, Upload, X } from "lucide-react";
import {
  accountsList,
  jobCreate,
  proxiesList,
  settingsGet,
  type Account,
  type MaskedProxyNode,
} from "@/lib/api";
import { faFileSize } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/components/shared/empty-state";

const MAX_UPLOAD = 200 * 1024 * 1024;
const ALLOWED_AUDIO_EXT = ["wav", "mp3", "m4a", "ogg", "flac"];

/**
 * درخواست جدید — a multipart form (prompt + optional audio + preferred
 * account/node). Everything is validated client-side first, and the
 * provider's own validation runs server-side on the job.
 */
export function CreateJobPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [prompt, setPrompt] = useState("");
  const [maxPromptChars, setMaxPromptChars] = useState(20_000);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [nodes, setNodes] = useState<MaskedProxyNode[]>([]);
  const [accountId, setAccountId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    settingsGet()
      .then((s) => setMaxPromptChars(s.settings.jobsMaxPromptChars))
      .catch(() => undefined);
    accountsList()
      .then(setAccounts)
      .catch(() => undefined);
    proxiesList()
      .then(setNodes)
      .catch(() => undefined);
  }, []);

  const pickFile = (f: File | null) => {
    setFile(null);
    setFileError(null);
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_AUDIO_EXT.includes(ext)) {
      setFileError("فرمت فایل پشتیبانی نمی‌شود. فرمت‌های مجاز: wav, mp3, m4a, ogg, flac");
      return;
    }
    if (f.size > MAX_UPLOAD) {
      setFileError(`حجم فایل بیشتر از سقف ${faFileSize(MAX_UPLOAD)} است.`);
      return;
    }
    setFile(f);
  };

  const canSubmit = prompt.trim().length > 0 && !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await jobCreate({
        prompt: prompt.trim(),
        audio: file,
        preferredAccountId: accountId || null,
        preferredNodeId: nodeId || null,
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
            یک فایل صوتی و سؤالی که می‌خواهید درباره‌اش پاسخ بگیرید را انتخاب کنید. اعتبارسنجی نهایی
            توسط ارائه‌دهنده روی سرور انجام می‌شود.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-5">
            <Field label="سؤال / دستور" htmlFor="prompt">
              <Textarea
                id="prompt"
                rows={5}
                maxLength={maxPromptChars}
                showCount
                placeholder="مثلاً: خلاصه‌ی این گفت‌وگو را در پنج نکته بنویس…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground/90">فایل صوتی (اختیاری)</span>
              {file ? (
                <div className="flex items-center gap-3 rounded-field border-line border-border bg-field px-3 py-2.5">
                  <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" dir="ltr">
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">{faFileSize(file.size)}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="حذف فایل"
                    type="button"
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                  >
                    <X />
                  </Button>
                </div>
              ) : (
                <label
                  htmlFor="audio-file"
                  className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-field border border-dashed border-input bg-field/40 px-4 py-8 text-center transition-colors hover:bg-field"
                >
                  <AudioLines className="size-6 text-muted-foreground" />
                  <span className="text-sm font-medium">انتخاب فایل صوتی</span>
                  <span className="text-xs text-muted-foreground">
                    wav, mp3, m4a, ogg, flac — تا {faFileSize(MAX_UPLOAD)}
                  </span>
                </label>
              )}
              <input
                ref={fileRef}
                id="audio-file"
                type="file"
                accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
                className="sr-only"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
              {fileError && (
                <p role="alert" className="text-xs text-destructive">
                  {fileError}
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="حساب ترجیحی"
                htmlFor="account"
                hint={accounts.length === 0 ? "حسابی ثبت نشده است." : undefined}
              >
                <Select
                  id="account"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder="خودکار"
                  options={[
                    { value: "", label: "خودکار (به انتخاب سیستم)" },
                    ...accounts.map((a) => ({
                      value: a.id,
                      label: `${a.label}${a.status !== "ACTIVE" ? " — " + a.status : ""}`,
                    })),
                  ]}
                />
              </Field>
              <Field
                label="پراکسی ترجیحی"
                htmlFor="node"
                hint={nodes.length === 0 ? "پراکسی‌ای تعریف نشده است." : undefined}
              >
                <Select
                  id="node"
                  value={nodeId}
                  onChange={(e) => setNodeId(e.target.value)}
                  placeholder="خودکار"
                  options={[
                    { value: "", label: "خودکار (به انتخاب سیستم)" },
                    ...nodes.map((n) => ({ value: n.id, label: n.config.name })),
                  ]}
                />
              </Field>
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

      {accounts.length === 0 && (
        <EmptyState
          title="برای شروع، یک حساب ثبت کنید"
          description="بدون حساب فعال، درخواست در وضعیت «در انتظار حساب» می‌ماند."
          action={
            <Link to="/accounts">
              <Button variant="outline" size="sm">
                رفتن به حساب‌ها
              </Button>
            </Link>
          }
        />
      )}
    </div>
  );
}
