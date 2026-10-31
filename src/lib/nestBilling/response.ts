import { randomUUID } from "node:crypto";

import { CORS_HEADERS } from "@/shared/utils/cors";

import { countTextTokens, type TokenizerContext } from "@/shared/utils/tiktokenCounter";
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { calculateCostDetailed } from "@/lib/usage/costCalculator";

import { nestSettle } from "./client";
import { UsageAccumulator } from "./usageAccumulator";

export interface NestBillingContext {
  ticket: string;
  startedAt: number;
  model: string;
  promptTokensEstimate: number;
  signal?: AbortSignal;
  requestId?: string | null;
  /** T2.1：预检返回的幂等键（ticket 过期后 nest 用它定位预扣会话） */
  billingRequestId?: string | null;
  /** T3.4：规范化端点（/v1/chat/completions → nest 日志与令牌白名单） */
  endpoint?: string;
  /** T4.1 批 3：按次计价单位（图片张数等，缺省 1） */
  units?: number;
}

export interface ParsedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
  promptIncludesCache?: boolean;
}

/**
 * 单事件解析（兼容旧调用方/测试）。内部复用累加器，因此负数/重复事件语义同上。
 */
export function parseUsage(obj: any): ParsedUsage | null {
  const acc = new UsageAccumulator();
  acc.feed(obj);
  const result = acc.result();
  if (!result.seen) return null;
  return {
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    totalTokens: result.totalTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWrite1hTokens: result.cacheWrite1hTokens,
    // 保持旧契约字段集合不变（promptIncludesCache 由 withNestBilling 使用）
  };
}

function tokenizerContext(ctx: NestBillingContext): TokenizerContext {
  return { model: ctx.model };
}

/** 无上游 usage 时的估算：prompt 用预检估算值，completion 用已流出内容重新计数 */
function estimatedUsage(ctx: NestBillingContext, text: string): ParsedUsage {
  const promptTokens = Math.max(1, Math.floor(ctx.promptTokensEstimate || 1));
  const completionTokens = text ? countTextTokens(text, tokenizerContext(ctx)) : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    cacheWrite1hTokens: 0,
    promptIncludesCache: false,
  };
}

interface SettleState {
  settled: boolean;
  acc: UsageAccumulator;
  status: number;
  error: string | null;
  aborted: boolean;
  requestId: string | null;
  /** T2.4：请求级上游成本（USD，从响应头/SSE 注释读取） */
  upstreamCost: number | null;
  /** T2.4：实际路由后的模型/供应商（含回退/组合） */
  upstreamModel: string | null;
  upstreamProvider: string | null;
}

/** 头部/注释值可能是 encodeURIComponent 过的（非 ASCII），尽量还原 */
function decodeHeaderValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * 从 SSE 注释行读取 OmniRoute 元信息（T2.4/N11）。
 * 格式：`: x-omniroute-response-cost=0.0000123456`（与 buildOmniRouteSseMetadataComment 一致）
 */
function readSseMetaComment(line: string, state: SettleState): void {
  const body = line.slice(1).trim();
  const eq = body.indexOf("=");
  if (eq <= 0) return;
  const name = body.slice(0, eq).trim().toLowerCase();
  const value = body.slice(eq + 1).trim();
  if (name === OMNIROUTE_RESPONSE_HEADERS.responseCost.toLowerCase()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) state.upstreamCost = parsed;
    return;
  }
  if (name === OMNIROUTE_RESPONSE_HEADERS.model.toLowerCase()) {
    state.upstreamModel = decodeHeaderValue(value) ?? state.upstreamModel;
    return;
  }
  if (name === OMNIROUTE_RESPONSE_HEADERS.provider.toLowerCase()) {
    state.upstreamProvider = decodeHeaderValue(value) ?? state.upstreamProvider;
  }
}

async function settleOnce(ctx: NestBillingContext, state: SettleState): Promise<void> {
  if (state.settled) return;
  state.settled = true;

  const accumulated = state.acc.result();
  const text = state.acc.contentText();
  const aborted = state.aborted || ctx.signal?.aborted === true;
  const usage = accumulated.seen ? accumulated : estimatedUsage(ctx, text);
  const usageProvenance = accumulated.seen
    ? "upstream_usage"
    : aborted
      ? "estimated_abort"
      : "estimated";

  // N3：上游错误帧（慢路径下 HTTP 仍是 200）——没流出任何内容时按失败结算（nest 退款）；
  // 已产出部分内容则按实际用量结算，但保留错误文案。
  let status = state.status;
  let error = state.error;
  const hasContent = accumulated.contentChars > 0 || text.length > 0;
  if (accumulated.upstreamError) {
    if (!hasContent) {
      status = accumulated.upstreamError.status;
      error = accumulated.upstreamError.message;
    } else if (!error) {
      error = accumulated.upstreamError.message;
    }
  }

  // T2.4/N11：成本优先用 OmniRoute 自己算好的请求级成本；缺失时用合并后的 usage 现算。
  // 未定价（priced:false）不得传 0，否则毛利显示 100% 并掩盖 cost_pending。
  let upstreamCost = state.upstreamCost;
  if (upstreamCost == null && state.upstreamProvider) {
    try {
      // 口径适配：costCalculator 内部会从 input 里扣除 cacheRead/cacheWrite（OpenAI 口径）。
      // Claude 的 input_tokens **不包含**缓存 → 若直接传 promptTokens 会把输入成本扣成负数。
      const inputForCost = usage.promptIncludesCache
        ? usage.promptTokens
        : usage.promptTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      const detailed = await calculateCostDetailed(
        state.upstreamProvider,
        state.upstreamModel ?? ctx.model,
        {
          input: inputForCost,
          output: usage.completionTokens,
          cached_tokens: usage.cacheReadTokens,
          cache_creation_input_tokens: usage.cacheWriteTokens,
        },
        { provider: state.upstreamProvider, model: state.upstreamModel ?? ctx.model }
      );
      if (detailed.priced && detailed.costUsd > 0) upstreamCost = detailed.costUsd;
    } catch {
      // 成本现算失败不阻断结算：nest 会继续标记 cost_pending，由 Phase 5 回填
    }
  }

  await nestSettle({
    ticket: ctx.ticket,
    status,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWrite1hTokens: usage.cacheWrite1hTokens,
      promptIncludesCache: usage.promptIncludesCache === true,
    },
    durationMs: Date.now() - ctx.startedAt,
    aborted,
    error,
    upstreamModel: state.upstreamModel ?? ctx.model,
    upstreamProvider: state.upstreamProvider ?? null,
    upstreamCost,
    omnirouteRequestId: state.requestId ?? ctx.requestId ?? null,
    traceId: state.requestId ?? ctx.requestId ?? null,
    billingRequestId: ctx.billingRequestId ?? null,
    usageProvenance,
    endpoint: ctx.endpoint ?? null,
    model: ctx.model,
    units: ctx.units,
  });
}

/** Wrap a chat response so its usage is settled exactly once. */
export function withNestBilling(response: Response, ctx: NestBillingContext | null): Response {
  if (!ctx) return response;
  const headerCost = Number(response.headers.get(OMNIROUTE_RESPONSE_HEADERS.responseCost) ?? "");
  const state: SettleState = {
    settled: false,
    acc: new UsageAccumulator(),
    status: response.status,
    error: response.ok ? null : `upstream HTTP ${response.status}`,
    aborted: false,
    // 计费同步（D4）：优先使用路由层生成的 reqId（= call_logs.correlation_id），
    // 上游响应头只作兜底，避免 settle 键与调用日志错位。
    requestId:
      ctx.requestId ??
      response.headers.get("x-request-id") ??
      response.headers.get("x-correlation-id") ??
      null,
    // T2.4：非流式响应：成本/实际模型/供应商都在响应头；流式由 SSE 注释行补齐
    upstreamCost: Number.isFinite(headerCost) && headerCost > 0 ? headerCost : null,
    upstreamModel: decodeHeaderValue(response.headers.get(OMNIROUTE_RESPONSE_HEADERS.model)),
    upstreamProvider: decodeHeaderValue(response.headers.get(OMNIROUTE_RESPONSE_HEADERS.provider)),
  };

  // Client cancellations should still settle against what was consumed.
  ctx.signal?.addEventListener(
    "abort",
    () => {
      state.aborted = true;
      void settleOnce(ctx, state);
    },
    { once: true }
  );

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body) {
    void settleOnce(ctx, state);
    return response;
  }

  if (contentType.includes("text/event-stream")) {
    const decoder = new TextDecoder();
    let buffer = "";
    let lastEvent = "";
    const transformer = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        try {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            // T2.4/N11：SSE 元信息以注释行下发（`: x-omniroute-response-cost=…`）
            if (line.startsWith(":")) {
              readSseMetaComment(line, state);
              continue;
            }
            // `event: error` 后紧跟的 data 帧是错误体（N3）
            if (line.startsWith("event:")) {
              lastEvent = line.slice(6).trim();
              if (lastEvent === "error") state.acc.markError(502, "upstream error frame");
              continue;
            }
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              state.acc.feed(JSON.parse(data));
            } catch {
              // Ignore non-JSON keepalive frames.
            }
          }
        } catch {
          // Byte accounting is best-effort; never break the response stream.
        }
      },
      async flush() {
        await settleOnce(ctx, state);
      },
    });
    const stream = response.body.pipeThrough(transformer);
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const clone = response.clone();
  void clone
    .text()
    .then((text) => {
      try {
        const parsed = JSON.parse(text);
        state.acc.feed(parsed);
        if (!response.ok) {
          state.error = String(parsed?.error?.message ?? state.error ?? "upstream error");
        }
      } catch {
        // 非 JSON 响应：按字符量估算（保留原行为）
        state.acc.feed({ choices: [{ message: { content: text } }] });
      }
    })
    .catch(() => {})
    .finally(() => settleOnce(ctx, state));

  return response;
}

/**
 * 计费拒绝的文案/类型映射（T1.4 / N5 / §10-16）。
 *
 * nest 的 `reason` 是唯一稳定的业务码；HTTP 码与文案在这里固定，避免再次出现
 * “余额不足返回 429 → SDK 自动重试风暴”与“业务码丢失 → 文案永远不命中”。
 */
export interface BillingErrorMapping {
  status: number;
  message: string;
  /** OpenAI 错误体里的 `error.type` */
  openaiType: string;
  /** Anthropic 错误体里的 `error.type` */
  anthropicType: string;
  /** 客户端是否应该重试（Claude Code 读 x-should-retry） */
  shouldRetry: boolean;
}

const BILLING_ERROR_MAP: Readonly<Record<string, BillingErrorMapping>> = {
  invalid_token: {
    status: 401,
    message: "无效的 API 令牌",
    openaiType: "authentication_error",
    anthropicType: "authentication_error",
    shouldRetry: false,
  },
  token_forbidden: {
    status: 403,
    message: "令牌无权限",
    openaiType: "permission_error",
    anthropicType: "permission_error",
    shouldRetry: false,
  },
  token_frozen: {
    status: 403,
    message: "令牌已被风控冻结",
    openaiType: "permission_error",
    anthropicType: "permission_error",
    shouldRetry: false,
  },
  ip_not_allowed: {
    status: 403,
    message: "当前 IP 不在令牌允许范围内",
    openaiType: "permission_error",
    anthropicType: "permission_error",
    shouldRetry: false,
  },
  endpoint_not_allowed: {
    status: 403,
    message: "该端点不在令牌允许范围内",
    openaiType: "permission_error",
    anthropicType: "permission_error",
    shouldRetry: false,
  },
  model_not_allowed: {
    status: 403,
    message: "该模型不在令牌允许范围内",
    openaiType: "permission_error",
    anthropicType: "permission_error",
    shouldRetry: false,
  },
  group_not_allowed: {
    status: 403,
    message: "该模型在您的分组内不可用",
    openaiType: "permission_error",
    anthropicType: "permission_error",
    shouldRetry: false,
  },
  model_not_found: {
    status: 404,
    message: "模型不可用或未定价",
    openaiType: "not_found_error",
    anthropicType: "not_found_error",
    shouldRetry: false,
  },
  model_unpriced: {
    status: 404,
    message: "模型不可用或未定价",
    openaiType: "not_found_error",
    anthropicType: "not_found_error",
    shouldRetry: false,
  },
  insufficient_balance: {
    status: 402,
    message: "余额不足，请先充值",
    openaiType: "billing_error",
    anthropicType: "billing_error",
    shouldRetry: false,
  },
  quota_exhausted: {
    status: 402,
    message: "额度已耗尽",
    openaiType: "billing_error",
    anthropicType: "billing_error",
    shouldRetry: false,
  },
  parent_quota_exhausted: {
    status: 402,
    message: "父密钥额度已耗尽",
    openaiType: "billing_error",
    anthropicType: "billing_error",
    shouldRetry: false,
  },
  debt_pending: {
    status: 402,
    message: "存在待处理的欠费，请先结清",
    openaiType: "billing_error",
    anthropicType: "billing_error",
    shouldRetry: false,
  },
  usage_limit_exceeded: {
    status: 429,
    message: "已超出用量限额",
    openaiType: "rate_limit_error",
    anthropicType: "rate_limit_error",
    shouldRetry: true,
  },
  rate_limited: {
    status: 429,
    message: "请求过于频繁，请稍后重试",
    openaiType: "rate_limit_error",
    anthropicType: "rate_limit_error",
    shouldRetry: true,
  },
  concurrency_limit_exceeded: {
    status: 429,
    message: "并发数超限，请稍后重试",
    openaiType: "rate_limit_error",
    anthropicType: "rate_limit_error",
    shouldRetry: true,
  },
  billing_unavailable: {
    status: 503,
    message: "计费服务暂不可用，请稍后重试",
    openaiType: "api_error",
    anthropicType: "api_error",
    shouldRetry: true,
  },
  internal_error: {
    status: 500,
    message: "计费服务内部错误，请稍后重试",
    openaiType: "api_error",
    anthropicType: "api_error",
    shouldRetry: true,
  },
};

/** 未知 reason 时的兜底：按 HTTP 码分类 */
function fallbackMapping(status: number): BillingErrorMapping {
  if (status === 401)
    return {
      status: 401,
      message: "无效的 API 令牌",
      openaiType: "authentication_error",
      anthropicType: "authentication_error",
      shouldRetry: false,
    };
  if (status === 402) return BILLING_ERROR_MAP.insufficient_balance;
  if (status === 403) return BILLING_ERROR_MAP.token_forbidden;
  if (status === 404) return BILLING_ERROR_MAP.model_not_found;
  if (status === 429) return BILLING_ERROR_MAP.rate_limited;
  if (status >= 500) return BILLING_ERROR_MAP.billing_unavailable;
  return BILLING_ERROR_MAP.internal_error;
}

/** reason → 固定映射；未知 reason 按 HTTP 码兜底 */
export function resolveBillingErrorMapping(
  reason: string | undefined,
  status: number
): BillingErrorMapping {
  const mapped = reason ? BILLING_ERROR_MAP[reason] : undefined;
  return mapped ?? fallbackMapping(status);
}

/**
 * 错误体翻译所需的最小结构（比 Extract<NestPreflightResult,{ok:false}> 宽松，
 * 避免在 strict:false 的仓库配置下因联合类型收窄失效而报错）。
 */
export interface NestBillingErrorInput {
  status: number;
  message: string;
  code?: string;
  reason?: string;
  retryAfterSeconds?: number;
}

/**
 * 把预检失败翻译成客户端错误体。
 * `format` 默认 `openai`（向后兼容）；T3.2 的 `/v1/messages` 传 `anthropic`。
 */
export function nestBillingErrorResponse(
  result: NestBillingErrorInput,
  format: "openai" | "anthropic" = "openai"
): Response {
  const mapping = resolveBillingErrorMapping(result.reason ?? result.code, result.status);
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "x-should-retry": mapping.shouldRetry ? "true" : "false",
    // Claude Code 会展示 request-id；预检拒绝也带一个，便于对账排查
    "request-id": randomUUID(),
  };
  if (mapping.shouldRetry && result.retryAfterSeconds && result.retryAfterSeconds > 0) {
    headers["Retry-After"] = String(Math.ceil(result.retryAfterSeconds));
  }
  const body =
    format === "anthropic"
      ? {
          type: "error",
          error: { type: mapping.anthropicType, message: mapping.message },
        }
      : {
          error: {
            message: mapping.message,
            type: mapping.openaiType,
            code: result.reason ?? result.code ?? "nest_billing_error",
          },
        };
  return new Response(JSON.stringify(body), { status: mapping.status, headers });
}
