import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps {
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  id?: string;
}

/** چک‌باکس. Box at the inline-start, label after it; supports indeterminate. */
export function Checkbox({
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  label,
  description,
  className,
  id,
}: CheckboxProps) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const state = checked ?? internal;
  const autoId = React.useId();
  const boxId = id ?? autoId;

  function toggle() {
    const next = state === "indeterminate" ? true : !state;
    if (checked === undefined) setInternal(next);
    onCheckedChange?.(next);
  }

  const box = (
    <button
      id={boxId}
      type="button"
      role="checkbox"
      aria-checked={state === "indeterminate" ? "mixed" : state}
      disabled={disabled}
      onClick={toggle}
      className={cn(
        "mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[min(var(--shape-control),0.25rem)] border-line transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        state ? "border-primary bg-primary text-primary-foreground" : "border-input bg-field",
      )}
    >
      {state === "indeterminate" ? (
        <Minus className="size-3" />
      ) : state ? (
        <Check className="size-3" />
      ) : null}
    </button>
  );

  if (!label) return box;
  return (
    <label
      htmlFor={boxId}
      className={cn(
        "flex cursor-pointer items-start gap-2.5 text-sm",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      {box}
      <span>
        <span className="block leading-5">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}
