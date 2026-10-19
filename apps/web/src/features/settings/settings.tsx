import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { secretsList, settingsGet, settingsPut, type SecretEntry } from "@/lib/api";
import { faNumber } from "@/lib/utils";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBanner } from "@/components/shared/error-banner";
import { RelativeTime } from "@/components/shared/relative-time";
import { useToast } from "@/components/ui/toast";

/**
 * تنظیمات — the small runtime whitelist (job defaults), the masked secret
 * inventory (refs/kinds only — the API never returns values), and the
 * session token controls.
 */
export function SettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<{
    jobsMaxAttemptsDefault: number;
    jobsMaxPromptChars: number;
  } | null>(null);
  const [secrets, setSecrets] = useState<SecretEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, sec] = await Promise.all([settingsGet(), secretsList()]);
      setSettings(s.settings);
      setSecrets(sec.secrets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "بارگذاری نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await settingsPut({
        jobsMaxAttemptsDefault: settings.jobsMaxAttemptsDefault,
        jobsMaxPromptChars: settings.jobsMaxPromptChars,
      });
      toast({ title: "تنظیمات ذخیره شد", variant: "success" });
    } catch (err) {
      toast({
        title: "ذخیره ناموفق بود",
        description: err instanceof Error ? err.message : undefined,
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>تنظیمات پردازش</CardTitle>
          <CardDescription>
            فقط این مقدارها از طریق رابط قابل تغییرند؛ بقیه‌ی پیکربندی (پورت، کلید گاوصندوق،
            allowlist) در سطح محیط‌ی سرور است.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!settings ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="حداکثر تلاش پیش‌فرض"
                  htmlFor="max-attempts"
                  hint="برای درخواست‌های جدید (۱ تا ۱۰)."
                >
                  <Input
                    id="max-attempts"
                    type="number"
                    dir="ltr"
                    min={1}
                    max={10}
                    value={settings.jobsMaxAttemptsDefault}
                    onChange={(e) =>
                      setSettings((s) =>
                        s
                          ? {
                              ...s,
                              jobsMaxAttemptsDefault: Math.min(
                                10,
                                Math.max(1, Number(e.target.value)),
                              ),
                            }
                          : s,
                      )
                    }
                  />
                </Field>
                <Field
                  label="حداکثر کاراکتر سؤال"
                  htmlFor="max-prompt"
                  hint={`در حال حاضر: ${faNumber(settings.jobsMaxPromptChars)} کاراکتر`}
                >
                  <Input
                    id="max-prompt"
                    type="number"
                    dir="ltr"
                    min={100}
                    max={100000}
                    step={100}
                    value={settings.jobsMaxPromptChars}
                    onChange={(e) =>
                      setSettings((s) =>
                        s
                          ? {
                              ...s,
                              jobsMaxPromptChars: Math.min(
                                100000,
                                Math.max(100, Number(e.target.value)),
                              ),
                            }
                          : s,
                      )
                    }
                  />
                </Field>
              </div>
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                <Save />
                {saving ? "در حال ذخیره…" : "ذخیره‌ی تغییرات"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>رازهای نگهداری‌شده</CardTitle>
          <CardDescription>
            فهرست ارجاعات گاوصندوق — فقط نام ارجاع (به شکل ماسک‌دار) و نوع. مقادیر هرگز از سرور
            فرستاده نمی‌شوند.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!secrets ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : secrets.length === 0 ? (
            <p className="text-sm text-muted-foreground">راز تعریف نشده است.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ارجاع</TableHead>
                  <TableHead>نوع</TableHead>
                  <TableHead>به‌روزرسانی</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {secrets.map((s) => (
                  <TableRow key={s.ref}>
                    <TableCell className="text-xs" dir="ltr">
                      {s.ref}
                    </TableCell>
                    <TableCell className="text-xs" dir="ltr">
                      {s.kind}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <RelativeTime iso={s.updatedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>حساب کاربری</CardTitle>
          <CardDescription>
            این نسخه‌ی تک‌کاربر است: بدون ساخت کاربر و بدون توکن؛ دسترسی از طریق همین مرورگر و فقط
            روی همین دستگاه (بسته‌بندی loopback سرور) ممکن است.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            تازه‌سازی
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
