import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** خطای بارگذاری با دکمه‌ی تلاش مجدد. */
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-surface border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
    >
      <p className="flex items-center gap-2 text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        {message}
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="ms-1">
          تلاش مجدد
        </Button>
      )}
    </div>
  );
}
