import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";

interface Row {
  id: string;
  name: string;
}

const columns: ColumnDef<Row>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "名称" },
];

describe("DataTable", () => {
  it("loading 状态显示 5 行骨架", () => {
    const { container } = render(<DataTable columns={columns} data={[]} loading />);
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBe(5 * columns.length);
  });

  it("空数据展示 emptyText", () => {
    render(<DataTable columns={columns} data={[]} emptyText="无内容" />);
    expect(screen.getByText("无内容")).toBeInTheDocument();
  });

  it("渲染数据行并触发 onRowClick", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={[{ id: "u1", name: "Alice" }]}
        onRowClick={onRowClick}
      />,
    );
    expect(screen.getByText("u1")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Alice"));
    expect(onRowClick).toHaveBeenCalledWith({ id: "u1", name: "Alice" });
  });
});
