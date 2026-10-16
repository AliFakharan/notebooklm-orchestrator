import type { AccountStatus, JobStatus } from "@nlo/shared";
import { Badge } from "@/components/ui/badge";
import { ACCOUNT_STATUS_LABELS, JOB_STATUS_LABELS } from "@/lib/api";

const JOB_VARIANT: Record<
  JobStatus,
  "default" | "secondary" | "success" | "warning" | "destructive" | "brand"
> = {
  CREATED: "secondary",
  VALIDATING: "secondary",
  QUEUED: "secondary",
  WAITING_FOR_ACCOUNT: "warning",
  WAITING_FOR_PROXY: "warning",
  RUNNING: "brand",
  RETRY_WAIT: "warning",
  SUCCEEDED: "success",
  FAILED: "destructive",
  NEEDS_ATTENTION: "warning",
  CANCEL_REQUESTED: "secondary",
  CANCELLED: "secondary",
};

const ACCOUNT_VARIANT: Record<
  AccountStatus,
  "default" | "secondary" | "success" | "warning" | "destructive"
> = {
  ACTIVE: "success",
  DEGRADED: "warning",
  RATE_LIMITED: "warning",
  AUTH_REQUIRED: "destructive",
  DISABLED: "secondary",
  UNKNOWN: "secondary",
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={JOB_VARIANT[status]}>{JOB_STATUS_LABELS[status]}</Badge>;
}

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return <Badge variant={ACCOUNT_VARIANT[status]}>{ACCOUNT_STATUS_LABELS[status]}</Badge>;
}
