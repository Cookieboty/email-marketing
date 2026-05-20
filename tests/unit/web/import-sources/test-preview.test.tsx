import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TestPreview } from "@/app/(dashboard)/import-sources/_components/test-preview";
import type { ImportTestResp } from "@/app/(dashboard)/import-sources/_components/types";

describe("TestPreview", () => {
  it("渲染 fetched 计数与前 N 行 JSON 预览", () => {
    const data: ImportTestResp = {
      fetched: 12,
      preview: [
        { email: "a@b.com" },
        { email: "c@d.com" },
      ],
      errors: [],
    };
    render(<TestPreview result={data} />);
    expect(screen.getByTestId("test-preview-fetched")).toHaveTextContent("12");
    expect(screen.getByTestId("test-preview-rows")).toHaveTextContent("a@b.com");
    expect(screen.queryByTestId("test-preview-errors")).toBeNull();
  });

  it("errors 非空时渲染错误列表", () => {
    const data: ImportTestResp = {
      fetched: 5,
      preview: [],
      errors: [
        { row: 1, field: "email", message: "Invalid email" },
        { row: 2, field: "email", message: "Missing field" },
      ],
    };
    render(<TestPreview result={data} />);
    expect(screen.getByTestId("test-preview-errors")).toBeInTheDocument();
    expect(screen.getAllByTestId("test-preview-error-row")).toHaveLength(2);
  });

  it("result=null 时显示占位提示", () => {
    render(<TestPreview result={null} />);
    expect(screen.getByTestId("test-preview-empty")).toBeInTheDocument();
  });
});
