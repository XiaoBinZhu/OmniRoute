/**
 * Outbox 回放 worker（T2.1）。
 *
 * 背景（P1-1）：`replayNestBillingOutbox()` 此前**没有任何调用点**——nest 短暂不可用
 * （如滚动部署）时完成的请求会写进 SQLite outbox，然后永不重发；而 ticket 在 Redis
 * 里 30 分钟过期后，nest 会对 `missing` 直接返回 ok（不扣费）→ 静默漏计费。
 *
 * 行为：
 *  - 每 30s 回放一批（默认 50）到期的 pending 行；
 *  - 401（共享密钥不一致）→ 暂停 5 分钟并打印错误（配置问题，重试无意义）；
 *  - 关闭开关：`NEST_BILLING_OUTBOX_WORKER=0`；
 *  - 单进程运行（SQLite 单写者），与 `isBackgroundServicesDisabled()` 兼容。
 *
 * @module lib/nestBilling/outboxWorker
 */

import { isNestBillingEnabled } from "./config";
import { getNestBillingOutboxStatus, replayNestBillingOutbox } from "./client";
const TICK_MS = 30_000;
const PAUSE_ON_UNAUTHORIZED_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let pausedUntil = 0;
let running = false;

/** 是否启用 worker（环境开关，默认开） */
export function isOutboxWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.NEST_BILLING_OUTBOX_WORKER ?? "1")
    .trim()
    .toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

/** 单次 tick（导出便于测试） */
export async function runOutboxTick(now = Date.now()): Promise<void> {
  if (running) return;
  if (now < pausedUntil) return;
  // 运行期也要尊重“关闭后台服务”（测试/排障时可能热设）
  if (!isNestBillingEnabled()) return;
  running = true;
  try {
    const outcome = await replayNestBillingOutbox(50);
    if (outcome.unauthorized) {
      pausedUntil = now + PAUSE_ON_UNAUTHORIZED_MS;
      console.error(
        "[nestBilling] outbox replay got 401 (edge secret mismatch) — worker paused for 5m. " +
          "结算仍在队列中，修复 NEST_EDGE_SECRET 后会自动恢复。"
      );
      return;
    }
    if (outcome.dead > 0) {
      console.error(`[nestBilling] outbox: ${outcome.dead} row(s) marked dead — 需要人工核查`);
    }
    if (outcome.sent > 0 || outcome.retried > 0) {
      const status = getNestBillingOutboxStatus();
      console.log(
        `[nestBilling] outbox replay: sent=${outcome.sent} retried=${outcome.retried} ` +
          `pending=${status.pending} dead=${status.dead} oldest=${status.oldestPendingAt ?? "-"}`
      );
    }
  } catch (error) {
    console.error("[nestBilling] outbox worker tick failed:", (error as Error)?.message ?? error);
  } finally {
    running = false;
  }
}

/** 启动 worker；返回 true 表示已启动（幂等） */
export function startNestBillingOutboxWorker(): boolean {
  if (!isNestBillingEnabled()) return false;
  if (!isOutboxWorkerEnabled()) {
    console.log("[STARTUP] Nest billing outbox worker disabled (NEST_BILLING_OUTBOX_WORKER=0)");
    return false;
  }
  if (timer) return false;
  timer = setInterval(() => void runOutboxTick(), TICK_MS);
  timer.unref?.();
  void runOutboxTick();
  console.log("[STARTUP] Nest billing outbox worker started (30s interval)");
  return true;
}

/** 停止 worker（测试/优雅关停用） */
export function stopNestBillingOutboxWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 测试用：重置暂停状态 */
export function resetOutboxWorkerPause(): void {
  pausedUntil = 0;
}
