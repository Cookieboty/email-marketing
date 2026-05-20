"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  JOB_STATUS_LABELS,
  type ImportJobRow,
} from "./types";

export interface JobStatusCellProps {
  job: ImportJobRow;
  onCancel: (job: ImportJobRow) => void;
}

const ACTIVE_STATUSES = new Set<ImportJobRow["status"]>([
  "PENDING",
  "RUNNING",
]);

function variantOf(status: ImportJobRow["status"]) {
  switch (status) {
    case "COMPLETED":
      return "default" as const;
    case "FAILED":
      return "destructive" as const;
    case "CANCELLED":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
}

export function JobStatusCell({ job, onCancel }: JobStatusCellProps) {
  const errorsHref = `/api/import-sources/${job.sourceId}/jobs/${job.id}/errors.csv`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Badge variant={variantOf(job.status)}>{JOB_STATUS_LABELS[job.status]}</Badge>
        {job.isDryRun ? (
          <Badge variant="outline" className="text-[10px]">
            Dry-run
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {ACTIVE_STATUSES.has(job.status) ? (
          <Button
            type="button"
            data-testid="job-cancel"
            variant="outline"
            size="sm"
            onClick={() => onCancel(job)}
          >
            取消
          </Button>
        ) : null}
        {job.totalErrored > 0 ? (
          <a
            data-testid="job-errors-link"
            href={errorsHref}
            download
            className="text-xs text-primary underline hover:no-underline"
          >
            下载 errors.csv
          </a>
        ) : null}
      </div>
    </div>
  );
}
