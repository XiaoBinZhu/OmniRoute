/**
 * Nest 预检的候选重试策略（T1.1 / N6）。
 *
 * Claude Code 会同时发送"陈旧的 `Authorization: Bearer sk-ant-…`"与有效的
 * `x-api-key: sk-nest…`；`extractApiKeyCandidates` 按 Bearer 优先排序，所以
 * 第一个候选可能被 nest 判 401。这条规则只允许在 **401（令牌无效）** 时换
 * 下一个候选：402/403/404/429/5xx 都是确定的计费结论，换候选只会放大错误。
 *
 * 抽成独立模块是为了可单测（路由本身依赖 handleChat/admission，单测成本高），
 * T3.1 的 `runNestPreflight` 与 T3.2 的 `/v1/messages` 直接复用这里。
 *
 * @module lib/nestBilling/preflight
 */

import { nestPreflight, type NestPreflightInput, type NestPreflightResult } from "./client";

export type NestBillingModelShape = { parsedBodyIsRecord: boolean; model: string };

/**
 * N4：有 nest 候选凭据却拿不到可计费的 model 时，必须在进入上游前拒绝
 * （fail-closed），否则请求会以"未预检"状态免费打到上游。
 */
export function nestPreflightShapeRejection(
  input: NestBillingModelShape
): { status: number; message: string } | null {
  if (!input.parsedBodyIsRecord) {
    return { status: 400, message: "Request body must be a JSON object" };
  }
  if (!input.model) {
    return { status: 400, message: "model is required" };
  }
  return null;
}

/**
 * 依次用凭据候选做预检：第一个成功即返回；401 且在候选表中还有下一个时继续，
 * 其它失败立即返回给调用方翻译成错误体。
 */
export async function preflightWithCandidates(
  candidates: readonly string[],
  input: Omit<NestPreflightInput, "key">
): Promise<NestPreflightResult> {
  if (candidates.length === 0) {
    return { ok: false, status: 401, message: "No nest credential candidate" };
  }
  let last: NestPreflightResult = {
    ok: false,
    status: 401,
    message: "No nest credential candidate",
  };
  for (let index = 0; index < candidates.length; index += 1) {
    last = await nestPreflight({ ...input, key: candidates[index] });
    if (last.ok) return last;
    const hasNextCandidate = index < candidates.length - 1;
    if (last.status !== 401 || !hasNextCandidate) return last;
  }
  return last;
}
