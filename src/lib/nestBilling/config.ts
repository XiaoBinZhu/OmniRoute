import {
  isNestBillingKeyCandidate as isNestBillingCredential,
  nestBilledEndpoint,
} from "./credentials";

/** 只读 env 形状（测试注入用，避免依赖完整 ProcessEnv） */
export type EnvLike = Record<string, string | undefined>;

/**
 * Nest billing flags (blueprint D2).
 *
 * `NEST_BILLING_ENABLED` defaults to 0: with it unset the gateway behaves
 * exactly as before (OmniRoute-only auth and local usage accounting).
 */
export function isNestBillingEnabled(env: EnvLike = process.env): boolean {
  const raw = String(env.NEST_BILLING_ENABLED ?? "0")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function nestBillingConfig(): {
  baseUrl: string;
  edgeSecret: string;
  timeoutMs: number;
} {
  return {
    baseUrl: String(process.env.NEST_BILLING_BASE_URL ?? "http://10.0.0.2:7001").replace(
      /\/+$/,
      ""
    ),
    edgeSecret: String(process.env.NEST_EDGE_SECRET ?? ""),
    timeoutMs: Math.max(500, Number(process.env.NEST_BILLING_TIMEOUT_MS ?? 5000) || 5000),
  };
}

/**
 * A1（T3.4）：预扣估算的输出上限。Claude Code 常发 max_tokens 32000/64000，
 * 满额预扣会误拒小余额用户；默认 8192，env `EDGE_ESTIMATE_COMPLETION_CAP` 可调。
 * 非法/非正数一律回落默认值（与 nest 侧启动断言分工：那边只拒绝非法值，不在此报错）。
 */
export function edgeEstimateCompletionCap(env: EnvLike = process.env): number {
  const raw = Number(String(env.EDGE_ESTIMATE_COMPLETION_CAP ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return 8192;
  return Math.floor(raw);
}

/**
 * Chat completions is the only route that participates in nest billing (Phase 1).
 * Delegates to the shared endpoint whitelist so `/api/v1/*` and `/v1/*` agree.
 */
export function isNestBillingChatPath(url: string): boolean {
  return nestBilledEndpoint(url) !== null;
}

/**
 * Nest credentials are `sk-` tokens (NOT Anthropic `sk-ant-*`) or system JWTs;
 * OmniRoute keys win when valid. Kept as a re-export so existing importers and
 * tests keep their entry point (T1.1 moved the logic to `credentials.ts`).
 */
export function isNestBillingKeyCandidate(key: string | null | undefined): boolean {
  return isNestBillingCredential(key);
}
