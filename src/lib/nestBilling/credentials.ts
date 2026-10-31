/**
 * Nest 计费凭据 / 端点判定（T1.1 收口）。
 *
 * 背景：`sk-` 令牌与 C 端 JWT 都必须交给 nest 预检（D2），而 Anthropic 官方
 * `sk-ant-*`（Claude Code 自带的 claude.ai OAuth / API key）不是 nest 令牌。
 * 判定散落在 config/route/policy 三处时口径必然漂移（N6），因此这里统一收口：
 *
 *  - 凭据候选：`sk-` 令牌（排除 `sk-ant-*`）或系统 JWT；
 *  - 端点白名单：按规范化路径判断（`/api/v1/*` → `/v1/*`），Phase 1 只有 chat，
 *    Phase 3/4 逐端点扩充；
 *  - 候选提取：保持 `extractApiKeyCandidates` 的优先级（Bearer → x-api-key →
 *    x-goog-api-key → URL token），最多返回 2 个，供"陈旧 Bearer + 有效
 *    x-api-key"逐个尝试。
 *
 * @module lib/nestBilling/credentials
 */

import { extractApiKeyCandidates } from "@/sse/services/clientApiKeyResolver";

/** JWT 形态：三段 base64url（header.payload.signature） */
const JWT_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
/** Anthropic 官方凭据前缀：Claude Code 会同时发 `Authorization: Bearer` 与 `x-api-key` */
const ANTHROPIC_KEY_PREFIX = "sk-ant-";

type NestCredentialRequest = {
  headers?: Parameters<typeof extractApiKeyCandidates>[0]["headers"];
  url?: string | null;
};

/**
 * nest 凭据候选：`sk-` 令牌（排除 Anthropic 官方 `sk-ant-*`）或系统 JWT。
 */
export function isNestBillingKeyCandidate(key: string | null | undefined): boolean {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(ANTHROPIC_KEY_PREFIX)) return false;
  return trimmed.startsWith("sk-") || JWT_RE.test(trimmed);
}

/**
 * 受 nest 计费的端点白名单（规范化后的路径）。
 * Phase 1 仅 chat；Phase 3 加 `/v1/messages`，Phase 4 逐批扩充。
 */
export const NEST_BILLED_ENDPOINTS: ReadonlySet<string> = new Set<string>([
  "/v1/chat/completions",
  // T3.2：Claude 协议（Claude Code / Anthropic SDK）
  "/v1/messages",
  // T4.1 批 1：Responses / Legacy Completions
  "/v1/responses",
  "/v1/completions",
  // T4.1 批 2：Embeddings / Rerank / Moderations
  "/v1/embeddings",
  "/v1/rerank",
  "/v1/moderations",
  // T4.1 批 3（已接入）：Images / Audio / Videos
  "/v1/images/generations",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
  "/v1/videos/generations",
]);

/** 只做校验不预扣的端点（T3.3 的 `count_tokens`）。 */
export const NEST_VERIFY_ONLY_ENDPOINTS: ReadonlySet<string> = new Set<string>([
  "/v1/messages/count_tokens",
]);

/**
 * 把请求 URL 规范化成 nest 端点路径：去掉尾斜杠，剥掉 `/api` 前缀
 * （OmniRoute 的 `/v1/*` 会重写到 `/api/v1/*`）。无法解析时返回 null。
 */
export function normalizeNestEndpointPath(url: string): string | null {
  try {
    const pathname = new URL(url, "http://localhost").pathname;
    const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    return trimmed.replace(/^\/api(?=\/v1\/)/, "") || "/";
  } catch {
    return null;
  }
}

/** 命中计费端点白名单时返回规范化路径，否则 null。 */
export function nestBilledEndpoint(url: string): string | null {
  const path = normalizeNestEndpointPath(url);
  return path && NEST_BILLED_ENDPOINTS.has(path) ? path : null;
}

/** 命中"只校验不扣费"端点白名单时返回规范化路径，否则 null。 */
export function nestVerifyOnlyEndpoint(url: string): string | null {
  const path = normalizeNestEndpointPath(url);
  return path && NEST_VERIFY_ONLY_ENDPOINTS.has(path) ? path : null;
}

/**
 * 请求里可交给 nest 的凭据候选，按 `extractApiKeyCandidates` 的优先级排序，
 * 最多 2 个。路由层用第一个做预检，遇 401（令牌无效）才换下一个。
 */
export function nestCredentialCandidates(request: NestCredentialRequest): string[] {
  return extractApiKeyCandidates(request).filter(isNestBillingKeyCandidate).slice(0, 2);
}
