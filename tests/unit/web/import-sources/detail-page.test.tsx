import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import useSWR from "swr";
import ImportSourceDetailPage from "@/app/(dashboard)/import-sources/[id]/page";
import { apiPost } from "@/lib/api-client";
import type {
  ImportJobRow,
  ImportSourceRow,
} from "@/app/(dashboard)/import-sources/_components/types";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "src_1" }),
}));

vi.mock("swr", () => ({
  default: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiDelete: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
  swrFetcher: vi.fn(),
}));

const source: ImportSourceRow = {
  id: "src_1",
  name: "Acme Users",
  description: null,
  baseUrl: "https://api.example.com/users",
  authType: "BEARER",
  authHeader: null,
  hasAuth: true,
  headers: null,
  paginationType: "offset",
  pageSize: 100,
  pageSizeParam: "limit",
  pageParam: "offset",
  cursorParam: null,
  cursorJsonPath: null,
  dataJsonPath: "$.data",
  fieldMapping: { email: "$.email" },
  schedule: null,
  enabled: true,
  lastRunAt: null,
  createdBy: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const failedWithCursor: ImportJobRow = {
  id: "job_1",
  sourceId: "src_1",
  status: "FAILED",
  isDryRun: false,
  totalFetched: 10,
  totalCreated: 1,
  totalUpdated: 0,
  totalSkipped: 0,
  totalErrored: 1,
  cursor: "next_cursor",
  currentPage: 2,
  startedAt: null,
  completedAt: null,
  failureReason: "boom",
  createdBy: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("ImportSourceDetailPage", () => {
  const mutateJobs = vi.fn();

  beforeEach(() => {
    vi.mocked(apiPost).mockResolvedValue({});
    mutateJobs.mockReset();
    vi.mocked(useSWR).mockImplementation((key: unknown) => {
      const url = typeof key === "string" ? key : "";
      if (url.includes("/jobs")) {
        return {
          data: { data: [], page: 1, pageSize: 20 },
          mutate: mutateJobs,
        } as never;
      }
      return { data: source, isLoading: false } as never;
    });
  });

  it("渲染后端 GET 直接返回的 ImportSource 对象", () => {
    render(<ImportSourceDetailPage />);
    expect(screen.getByText("Acme Users")).toBeInTheDocument();
  });

  it("正式同步先弹 ConfirmDialog，确认前不发 POST", () => {
    render(<ImportSourceDetailPage />);
    fireEvent.click(screen.getByText("正式同步"));
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("没有 FAILED + cursor 的任务时不显示续跑按钮", () => {
    render(<ImportSourceDetailPage />);
    expect(screen.queryByText("续跑")).toBeNull();
  });

  it("最近 FAILED 且有 cursor 时显示续跑按钮", () => {
    vi.mocked(useSWR).mockImplementation((key: unknown) => {
      const url = typeof key === "string" ? key : "";
      if (url.includes("/jobs")) {
        return {
          data: { data: [failedWithCursor], page: 1, pageSize: 20 },
          mutate: mutateJobs,
        } as never;
      }
      return { data: source, isLoading: false } as never;
    });

    render(<ImportSourceDetailPage />);
    expect(screen.getByText("续跑")).toBeInTheDocument();
  });
}
);
