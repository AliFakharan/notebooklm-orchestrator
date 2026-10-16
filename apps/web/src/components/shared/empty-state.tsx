import * as React from "react";
import { cn } from "@/lib/utils";

/** حالت خالی — Persian empty state with an icon, title, and optional action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-surface border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      {icon && <div className="mb-1 text-muted-foreground">{icon}</div>}
      <p className="text-sm font-semibold">{title}</p>
      {description && (
        <p className="max-w-sm text-xs leading-6 text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
