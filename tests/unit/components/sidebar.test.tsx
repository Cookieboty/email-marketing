import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Sidebar from "@/app/(dashboard)/_components/sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/users",
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("Sidebar", () => {
  it("渲染所有导航项并标记 active 项", () => {
    render(<Sidebar />);
    const labels = ["控制台", "用户", "标签", "模板", "模板片段", "媒体"];
    for (const l of labels) {
      expect(screen.getByText(l)).toBeInTheDocument();
    }
    const active = screen.getByText("用户").closest("a")!;
    expect(active.className).toContain("bg-primary");
    const inactive = screen.getByText("控制台").closest("a")!;
    expect(inactive.className).not.toContain("bg-primary");
  });

  it("包含 API Clients 入口并指向 /api-clients", () => {
    render(<Sidebar />);
    const link = screen.getByText("API Clients").closest("a")!;
    expect(link.getAttribute("href")).toBe("/api-clients");
  });

  it("包含数据导入入口并指向 /import-sources", () => {
    render(<Sidebar />);
    const link = screen.getByText("数据导入").closest("a")!;
    expect(link.getAttribute("href")).toBe("/import-sources");
  });
});
