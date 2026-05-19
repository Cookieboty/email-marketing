import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "@/lib/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger: structured JSON output", () => {
  it("emits JSON line with required fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("svc");
    log.info("hello", { foo: "bar" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]![0] as string;
    const obj = JSON.parse(line);
    expect(obj.level).toBe("info");
    expect(obj.component).toBe("svc");
    expect(obj.msg).toBe("hello");
    expect(obj.foo).toBe("bar");
    expect(typeof obj.ts).toBe("string");
  });

  it("filters by LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = createLogger("svc");
    log.info("ignored");
    log.warn("kept");
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    process.env.LOG_LEVEL = "info";
  });

  it("child appends sub component", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("svc").child("sub");
    log.info("x");
    const obj = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(obj.component).toBe("svc/sub");
  });

  it("error goes to stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger("svc");
    log.error("boom");
    expect(err).toHaveBeenCalledTimes(1);
  });
});
