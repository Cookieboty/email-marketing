import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ToastProvider, useToast } from "@/components/ui/toast";

function Trigger() {
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        toast({ title: "T", description: "D", variant: "destructive" })
      }
    >
      fire
    </button>
  );
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("显示 toast 并在 4s 后消失", () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByText("T")).toBeInTheDocument();
    expect(screen.getByText("D")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("T")).toBeNull();
  });

  it("provider 缺失时 useToast 静默不抛错", () => {
    function Bare() {
      const { toast } = useToast();
      toast({ title: "x" });
      return <span>ok</span>;
    }
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => render(<Bare />)).not.toThrow();
    spy.mockRestore();
  });
});
