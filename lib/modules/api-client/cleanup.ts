/**
 * Inbound 请求日志 TTL 清理。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 */

import { logger } from "@/lib/logger";
import { inboundRequestLogRepository } from "./repository";

const log = logger.child("inbound-cleanup");

/** 删除已过期的 InboundRequestLog 记录；分批执行，返回总删除条数。 */
export async function cleanupInboundRequestLogs(now: Date = new Date()): Promise<number> {
  const removed = await inboundRequestLogRepository.deleteExpired(now);
  if (removed > 0) {
    log.info("inbound request log cleanup done", { removed });
  }
  return removed;
}
