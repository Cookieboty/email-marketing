import { describe, it, expect, afterAll } from "vitest";
import { registerSchedules } from "@/scripts/worker";

describe("worker / registerSchedules()", () => {
  const tasks = registerSchedules();

  afterAll(() => {
    // 立即停止所有 cron，避免污染其它测试或 watch 模式
    for (const task of tasks) {
      try {
        task.stop();
      } catch {
        /* ignore */
      }
    }
  });

  it("注册 7 个 cron 槽位（每分钟 / 每 5 分钟 / 每 10 分钟 / 每日 3am / 每日 9am / 每日 10am / 每周）", () => {
    expect(tasks).toHaveLength(7);
  });

  it("每个槽位都是合法的 ScheduledTask（具备 stop 方法）", () => {
    for (const task of tasks) {
      expect(task).toBeDefined();
      expect(typeof task.stop).toBe("function");
    }
  });
});
