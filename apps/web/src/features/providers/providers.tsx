import { useCallback, useEffect, useState } from "react";
import { AudioLines, RefreshCw } from "lucide-react";
import type { CapabilityLevel } from "@nlo/shared";
import { healthReady, providerInfo, type ProviderInfo } from "@/lib/api";
import { fa } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorBanner } from "@/components/shared/error-banner";

const LEVEL_LABELS: Record<CapabilityLevel, string> = {
  implemented_tested: "پیاده‌سازی و تست‌شده",
  implemented_untested_live: "پیاده‌سازی‌شده (تست زنده انجام نشده)",
  experimental: "آزمایشی",
  unsupported: "پشتیبانی نمی‌شود",
  unavailable: "غیرقابل استفاده",
};

const LEVEL_VARIANT: Record<
  CapabilityLevel,
  "success" | "warning" | "secondary" | "destructive" | "brand"
> = {
  implemented_tested: "success",
  implemented_untested_live: "warning",
  experimental: "brand",
  unsupported: "secondary",
  unavailable: "destructive",
};

/**
 * ارائه‌دهنده — the honest capability matrix, straight from the provider
 * implementation (never inflated). Also shows readiness: provider
 * configuration and the proxy runtime state.
 */
export function ProvidersPage() {
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [ready, setReady] = useState<Awaited<ReturnType<typeof healthReady>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, r] = await Promise.all([providerInfo(), healthReady()]);
      setInfo(p);
      setReady(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "بارگذاری نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBanner message={error} onRetry={() => void load()} />;

  if (!info || !ready) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-control bg-brand text-brand-foreground">
              <AudioLines className="size-5" />
            </span>
            <div>
              <CardTitle>{info.isMock ? "ارائه‌دهنده‌ی آزمایشی (mock)" : info.name}</CardTitle>
              <p className="text-xs text-muted-foreground">
                وضعیت پیکربندی: {info.configured ? "آماده" : "پیکربندی‌نشده"}
                {info.liveDisabled && " · تست‌های زنده غیرفعال‌اند"}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            تازه‌سازی
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {!info.configured && info.issues.length > 0 && (
            <div className="rounded-field border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {info.issues.map((i) => (
                <p key={i}>{i}</p>
              ))}
            </div>
          )}
          <div className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            <p>
              <span className="text-muted-foreground">نوع ارائه‌دهنده: </span>
              <span dir="ltr">{info.name}</span>
            </p>
            <p>
              <span className="text-muted-foreground">زبان پردازش: </span>
              {info.isMock ? "شبیه‌ساز محلی (خروجی‌های mock)" : "کارگر پایتونی"}
            </p>
            <p>
              <span className="text-muted-foreground">پراکسی‌رات‌تایم: </span>
              {ready.proxyRuntime.state === "available"
                ? ready.proxyRuntime.name
                : `${ready.proxyRuntime.name} (پیکربندی‌نشده) — ${ready.proxyRuntime.reason}`}
            </p>
            <p>
              <span className="text-muted-foreground">تست زنده: </span>
              {info.liveDisabled ? "غیرفعال (NLO_LIVE_TESTS=0)" : "فعال"}
            </p>
          </div>
          {info.isMock ? (
            <p className="mt-1 rounded-field border border-border bg-field/50 p-3 text-xs leading-6 text-muted-foreground">
              همه‌ی خروجی‌های این بخش (پاسخ‌ها، رویدادها، فایل‌ها) توسط شبیه‌ساز تولید شده‌اند و هیچ
              درخواستی به سرویس واقعی NotebookLM ارسال نشده است.
            </p>
          ) : (
            <div className="mt-1 flex flex-col gap-2">
              <p className="rounded-field border border-brand/40 bg-brand/10 p-3 text-xs leading-6">
                حالت <span className="font-medium">زنده</span> فعال است: درخواست‌ها از طریق پراکسی
                انتخاب‌شده به سرویس واقعی NotebookLM می‌روند و ورود حساب از صفحه‌ی «حساب‌ها» (ورود
                واقعی با مرورگر) انجام می‌شود.
              </p>
              <p className="text-xs leading-6 text-muted-foreground">
                اعتبارسنجی زنده (ورود واقعی، مسیر واقعی پراکسی، شغول واقعی):{" "}
                <code className="rounded bg-field px-1 py-0.5" dir="ltr">
                  npm run verify:live --workspace @nlo/server
                </code>
                . منبع هر نتیجه (واقعی/شبیه‌سازی‌شده) در صفحه‌ی شغل ثبت و نمایش داده می‌شود.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>قابلیت‌ها</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>عملیات</TableHead>
                <TableHead>سطح</TableHead>
                <TableHead>توضیح</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {info.capabilities.map((c) => (
                <TableRow key={c.operation}>
                  <TableCell className="text-sm" dir="ltr">
                    {c.operation}
                  </TableCell>
                  <TableCell>
                    <Badge variant={LEVEL_VARIANT[c.level]}>{LEVEL_LABELS[c.level]}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.note ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">
            {fa(info.capabilities.length)} عملیات گزارش‌شده. سطوح فقط از پیاده‌سازی ارائه‌دهنده
            خوانده می‌شوند و هرگز به‌صورت دستی تغییر نمی‌کنند.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
