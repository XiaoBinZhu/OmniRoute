import { CORS_HEADERS } from "@/shared/utils/cors";

import { nestSettle, type NestPreflightResult } from "./client";

export interface NestBillingContext {
  ticket: string;
  startedAt: number;
  model: string;
  promptTokensEstimate: number;
  signal?: AbortSignal;
  requestId?: string | null;
}

export interface ParsedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Parse the many usage shapes emitted by OpenAI/Anthropic-compatible providers. */
export function parseUsage(obj: any): ParsedUsage | null {
  const usage = obj?.usage ?? obj?.message?.usage ?? obj?.response?.usage;
  if (!usage || typeof usage !== "object") return null;

  const promptTokens = num(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = num(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = num(usage.total_tokens) || promptTokens + completionTokens;
  if (!promptTokens && !completionTokens && !totalTokens) return null;

  const promptDetails = usage.prompt_tokens_details ?? {};
  const cacheReadTokens =
    num(usage.cache_read_input_tokens ?? usage.cache_read_tokens) ||
    num(promptDetails.cached_tokens);
  const cacheWriteTokens =
    num(usage.cache_creation_input_tokens ?? usage.cache_write_tokens) ||
    num(promptDetails.cache_creation_tokens);
  const cacheWrite1hTokens = num(usage.cache_write_1h_tokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheWriteTokens,
    cacheReadTokens,
    cacheWrite1hTokens,
  };
}

function contentChars(obj: any): number {
  const choice = Array.isArray(obj?.choices) ? obj.choices[0] : null;
  const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce(
      (sum, part) => sum + (typeof part?.text === "string" ? part.text.length : 0),
      0
    );
  }
  return 0;
}

function estimatedUsage(ctx: NestBillingContext, chars: number): ParsedUsage {
  const promptTokens = Math.max(1, Math.floor(ctx.promptTokensEstimate || 1));
  const completionTokens = Math.max(1, Math.ceil(chars / 4));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

async function settleOnce(
  ctx: NestBillingContext,
  state: {
    settled: boolean;
    usage: ParsedUsage | null;
    chars: number;
    status: number;
    error: string | null;
    aborted: boolean;
    requestId: string | null;
  }
): Promise<void> {
  if (state.settled) return;
  state.settled = true;
  const usage = state.usage ?? estimatedUsage(ctx, state.chars);
  await nestSettle({
    ticket: ctx.ticket,
    status: state.status,
    usage,
    durationMs: Date.now() - ctx.startedAt,
    aborted: state.aborted || ctx.signal?.aborted === true,
    error: state.error,
    upstreamModel: ctx.model,
    omnirouteRequestId: state.requestId ?? ctx.requestId ?? null,
    traceId: state.requestId ?? ctx.requestId ?? null,
  });
}

/** Wrap a chat response so its usage is settled exactly once. */
export function withNestBilling(response: Response, ctx: NestBillingContext | null): Response {
  if (!ctx) return response;
  const state = {
    settled: false,
    usage: null as ParsedUsage | null,
    chars: 0,
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
    const transformer = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        try {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const usage = parseUsage(parsed);
              if (usage) state.usage = usage;
              state.chars += contentChars(parsed);
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
        const usage = parseUsage(parsed);
        if (usage) state.usage = usage;
        state.chars = contentChars(parsed);
        if (!response.ok) {
          state.error = String(parsed?.error?.message ?? state.error ?? "upstream error");
        }
      } catch {
        state.chars = text.length;
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
 * 把预检失败翻译成客户端错误体。
 * `format` 默认 `openai`（向后兼容）；T3.2 的 `/v1/messages` 传 `anthropic`。
 */
export function nestBillingErrorResponse(
  result: Extract<NestPreflightResult, { ok: false }>,
  format: "openai" | "anthropic" = "openai"
): Response {
  const mapping = resolveBillingErrorMapping(result.reason ?? result.code, result.status);
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "x-should-retry": mapping.shouldRetry ? "true" : "false",
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
