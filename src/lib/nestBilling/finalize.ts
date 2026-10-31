/**
 * 路由级计费收口（Phase 4 codex 复审修复）。
 *
 * 自定义路由（embeddings/rerank/moderations/images/audio/videos）在预检成功后
 * 可能因参数/模型/凭据等**早退**返回 4xx，这些分支此前不会 settle，导致 Nest 侧的
 * hold/并发 lease 一直占用到恢复任务回收（合法用户被临时卡额度）。
 *
 * 这里在出口统一收口：
 * - 已结算/已包装（`__nestFinalized`）→ 原样返回；
 * - 4xx/5xx → 用 abort settle 立即退款；
 * - 2xx → `withNestBilling` 包装（成功结算）。
 *
 * 路由只需在预检成功时 `rememberNestCtx(request, ctx)`。
 */

import { nestSettle } from "./client";
import { nestAbortSettleInput } from "./guard";
import { withNestBilling, type NestBillingContext } from "./response";

const CTX_KEY = "__nestBillingCtx";
const FINALIZED_KEY = "__nestFinalized";

export function rememberNestCtx(request: Request, ctx: NestBillingContext | null): void {
  if (!ctx) return;
  (request as unknown as Record<string, unknown>)[CTX_KEY] = ctx;
}

export function markNestFinalized(response: Response): Response {
  (response as unknown as Record<string, unknown>)[FINALIZED_KEY] = true;
  return response;
}

/** 包装路由处理器：在出口做 settle/refund 收口。 */
export function withNestFinalize<TReq extends Request, TCtx>(
  handler: (request: TReq, context?: TCtx) => Promise<Response>
): (request: TReq, context?: TCtx) => Promise<Response> {
  return async (request: TReq, context?: TCtx): Promise<Response> => {
    try {
      const response = await handler(request, context);
      const ctx = (request as unknown as Record<string, unknown>)[CTX_KEY] as
        NestBillingContext | undefined;
      if (!ctx || !response) return response;
      if ((response as unknown as Record<string, unknown>)[FINALIZED_KEY]) return response;
      // 仅 2xx 视为成功结算；3xx/4xx/5xx 一律退款
      if (response.status < 200 || response.status >= 300) {
        void nestSettle(
          nestAbortSettleInput(ctx, new Error(`pre_upstream_reject_${response.status}`))
        );
        return markNestFinalized(response);
      }
      return markNestFinalized(withNestBilling(response, ctx));
    } catch (error) {
      // 异常也必须退款：否则 hold/并发 lease 会占用到恢复任务回收
      const ctx = (request as unknown as Record<string, unknown>)[CTX_KEY] as
        NestBillingContext | undefined;
      if (ctx) void nestSettle(nestAbortSettleInput(ctx, error));
      throw error;
    }
  };
}
