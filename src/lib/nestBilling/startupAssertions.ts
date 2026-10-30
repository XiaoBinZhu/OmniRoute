/**
 * Nest 计费启动断言（T1.1 / N4 / N9 / N22）。
 *
 * 用 `NEST_BILLING_ENABLED=1` 跑线上时，以下三种配置会让计费"看起来在工作、
 * 实际不工作"，必须在进程启动阶段 fail-fast，而不是等到对账时才发现：
 *
 *  1. `NEST_EDGE_SECRET` 为空 → 预检照常成功、`nestSettle` 直接返回错误且
 *     不入 outbox，结算静默丢失（N9）；
 *  2. 自托管分流变量非空 → `isSelfHostedEntryConfigured()` 在 nest 预检之前
 *     就应答请求，整条计费链路被旁路（N4）；
 *  3. （nest 侧对等项）`OMNIROUTE_KEY_MIRROR` 必须为假、`EDGE_SETTLE_SECRET`
 *     非空，由 nest 的启动断言负责（F1 已否决 M6 镜像路线）。
 *
 * @module lib/nestBilling/startupAssertions
 */

import { isNestBillingEnabled, type EnvLike } from "./config";

/** 自托管统一入口的环境变量（与 open-sse/services/selfHostedEntry.ts 保持一致） */
export const SELF_HOSTED_ENTRY_ENV_KEYS = [
  "OMNIROUTE_SELF_HOSTED_PROVIDERS",
  "OMNIROUTE_SELF_HOSTED_PROVIDERS_FILE",
] as const;

/** 纯函数：返回配置问题列表（空数组表示通过）。便于单测，不产生副作用。 */
export function collectNestBillingEnvIssues(env: EnvLike = process.env): string[] {
  if (!isNestBillingEnabled(env)) return [];
  const issues: string[] = [];
  if (!String(env.NEST_EDGE_SECRET ?? "").trim()) {
    issues.push(
      "NEST_EDGE_SECRET is empty while NEST_BILLING_ENABLED=1 — " +
        "settle would be silently dropped (never queued to the outbox)."
    );
  }
  for (const key of SELF_HOSTED_ENTRY_ENV_KEYS) {
    if (String(env[key] ?? "").trim()) {
      issues.push(
        `${key} is set — the self-hosted divert answers before the nest preflight, bypassing billing.`
      );
    }
  }
  return issues;
}

/**
 * 启动断言：有问题则打印原因并退出进程（与 `enforceWebRuntimeEnv` 同样的
 * fail-fast 语义）。`env`/`exit` 可注入，便于测试。
 */
export function enforceNestBillingRuntimeEnv(
  env: EnvLike = process.env,
  logger: Pick<Console, "error"> = console,
  exit: (code: number) => never = ((code: number) => process.exit(code)) as (code: number) => never
): void {
  const issues = collectNestBillingEnvIssues(env);
  if (issues.length === 0) return;

  logger.error("");
  logger.error("═══════════════════════════════════════════════════");
  logger.error("  ❌  STARTUP: Invalid nest billing configuration");
  logger.error("═══════════════════════════════════════════════════");
  for (const issue of issues) {
    logger.error(`  • ${issue}`);
  }
  logger.error("");
  logger.error("  Fix the environment and restart the server.");
  logger.error("  Secrets are intentionally not printed.");
  logger.error("═══════════════════════════════════════════════════");
  logger.error("");
  exit(1);
}
