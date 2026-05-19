import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn()", () => {
  it("合并多个类名", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("跳过 falsy 值", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });

  it("使用 tailwind-merge 解决冲突，后者覆盖前者", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("支持条件对象语法", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });
});
