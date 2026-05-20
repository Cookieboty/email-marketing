import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FieldMappingEditor } from "@/app/(dashboard)/import-sources/_components/field-mapping-editor";

describe("FieldMappingEditor", () => {
  it("初始受控值为 JSON 字符串，输入合法 JSON 时 onChange 透出对象，valid=true", () => {
    const onChange = vi.fn();
    render(
      <FieldMappingEditor
        value={{ email: "$.email" }}
        onChange={onChange}
      />,
    );
    const ta = screen.getByTestId("field-mapping-textarea") as HTMLTextAreaElement;
    expect(ta.value).toContain("email");

    fireEvent.change(ta, {
      target: { value: '{"email":"$.email","name":"$.full_name"}' },
    });
    const last = onChange.mock.calls.at(-1)!;
    expect(last[0]).toEqual({ email: "$.email", name: "$.full_name" });
    expect(last[1].valid).toBe(true);
  });

  it("非法 JSON 时显示行内错误，且 onChange 第二参数 valid=false", () => {
    const onChange = vi.fn();
    render(
      <FieldMappingEditor
        value={{ email: "$.email" }}
        onChange={onChange}
      />,
    );
    const ta = screen.getByTestId("field-mapping-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '{ "email": $.x' } });
    expect(screen.getByTestId("field-mapping-error")).toBeInTheDocument();
    const last = onChange.mock.calls.at(-1)!;
    expect(last[1].valid).toBe(false);
  });

  it("缺 email 字段时报错", () => {
    const onChange = vi.fn();
    render(
      <FieldMappingEditor value={{ email: "$.x" }} onChange={onChange} />,
    );
    const ta = screen.getByTestId("field-mapping-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '{"name":"$.name"}' } });
    expect(screen.getByTestId("field-mapping-error")).toHaveTextContent(/email/i);
  });

  it("非法 JSON 时通知父表单禁用提交", () => {
    const onChange = vi.fn();
    render(
      <FieldMappingEditor
        value={{ email: "$.email" }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("field-mapping-textarea"), {
      target: { value: "{ nope" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      { email: "$.email" },
      expect.objectContaining({ valid: false }),
    );
  });
});
