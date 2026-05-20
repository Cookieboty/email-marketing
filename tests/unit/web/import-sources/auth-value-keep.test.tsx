import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthValueField } from "@/app/(dashboard)/import-sources/_components/auth-value-field";

describe("AuthValueField (编辑模式凭据保留逻辑)", () => {
  it("create 模式：直接显示输入框，无保留勾选", () => {
    const onChange = vi.fn();
    render(
      <AuthValueField
        mode="create"
        hasAuth={false}
        value=""
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId("auth-keep")).toBeNull();
    expect(screen.getByTestId("auth-value-input")).toBeInTheDocument();
  });

  it("edit + hasAuth: 默认勾选「保留现有凭据」，输入框 disabled", () => {
    const onChange = vi.fn();
    render(
      <AuthValueField
        mode="edit"
        hasAuth
        value=""
        onChange={onChange}
      />,
    );
    const keep = screen.getByTestId("auth-keep") as HTMLInputElement;
    expect(keep.checked).toBe(true);
    const input = screen.getByTestId("auth-value-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("取消勾选后输入框启用，输入会触发 onChange", () => {
    const onChange = vi.fn();
    render(
      <AuthValueField
        mode="edit"
        hasAuth
        value=""
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("auth-keep"));
    const input = screen.getByTestId("auth-value-input") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "new-token" } });
    expect(onChange).toHaveBeenLastCalledWith("new-token", { keep: false });
  });

  it("edit + !hasAuth: 不展示保留选项", () => {
    const onChange = vi.fn();
    render(
      <AuthValueField
        mode="edit"
        hasAuth={false}
        value=""
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId("auth-keep")).toBeNull();
  });
});
