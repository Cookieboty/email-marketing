import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { JobStatusCell } from "@/app/(dashboard)/import-sources/_components/job-status-cell";
import type { ImportJobRow } from "@/app/(dashboard)/import-sources/_components/types";

const base: ImportJobRow = {
  id: "j1",
  sourceId: "s1",
  status: "PENDING",
  isDryRun: false,
  totalFetched: 0,
  totalCreated: 0,
  totalUpdated: 0,
  totalSkipped: 0,
  totalErrored: 0,
  cursor: null,
  currentPage: 0,
  startedAt: null,
  completedAt: null,
  failureReason: null,
  createdBy: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("JobStatusCell", () => {
  it("PENDING 显示「取消」按钮", () => {
    const onCancel = vi.fn();
    render(<JobStatusCell job={base} onCancel={onCancel} />);
    expect(screen.getByTestId("job-cancel")).toBeInTheDocument();
  });

  it("RUNNING 显示「取消」按钮", () => {
    render(<JobStatusCell job={{ ...base, status: "RUNNING" }} onCancel={vi.fn()} />);
    expect(screen.getByTestId("job-cancel")).toBeInTheDocument();
  });

  it("COMPLETED 不显示「取消」按钮", () => {
    render(<JobStatusCell job={{ ...base, status: "COMPLETED" }} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("job-cancel")).toBeNull();
  });

  it("totalErrored>0 渲染下载链接，href 末尾为 /errors.csv", () => {
    render(
      <JobStatusCell
        job={{ ...base, status: "COMPLETED", totalErrored: 3 }}
        onCancel={vi.fn()}
      />,
    );
    const a = screen.getByTestId("job-errors-link") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toMatch(/\/errors\.csv$/);
  });

  it("totalErrored=0 不渲染下载链接", () => {
    render(<JobStatusCell job={{ ...base, status: "COMPLETED" }} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("job-errors-link")).toBeNull();
  });
});
