/**
 * 结构化 JSON 日志。
 *
 * 设计：
 * - 仅输出一行 JSON，便于在 stdout/stderr 中被聚合工具按行解析
 * - 字段固定：ts、level、component、msg、其余作为 context 展开
 * - 通过 LOG_LEVEL 过滤；level 序：debug < info < warn < error
 * - 不引入第三方 logger（pino/winston），保持 Edge / Node 通用
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level: LogLevel, component: string, msg: string, ctx?: Record<string, unknown>) {
  if (LEVELS[level] < currentThreshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...(ctx ?? {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(component: string): Logger;
}

export function createLogger(component: string): Logger {
  return {
    debug: (m, c) => emit("debug", component, m, c),
    info: (m, c) => emit("info", component, m, c),
    warn: (m, c) => emit("warn", component, m, c),
    error: (m, c) => emit("error", component, m, c),
    child: (sub) => createLogger(`${component}/${sub}`),
  };
}

export const logger = createLogger("app");
