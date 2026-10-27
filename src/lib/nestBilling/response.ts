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
    requestId:
      response.headers.get("x-request-id") ?? response.headers.get("x-correlation-id") ?? null,
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

/** Convert a preflight failure into an OpenAI-compatible error response. */
export function nestBillingErrorResponse(
  result: Extract<NestPreflightResult, { ok: false }>
): Response {
  const status = result.status >= 400 && result.status <= 599 ? result.status : 402;
  // 不向下游透传 Nest 原始错误文本，避免泄露内部地址/堆栈；按错误码给出安全文案
  const safeMessage =
    result.code === "parent_quota_exhausted"
      ? "父密钥额度已耗尽"
      : result.code === "insufficient_balance" || status === 402
        ? "余额不足，请先充值"
        : result.code === "model_not_found" || result.code === "model_unpriced"
          ? "模型不可用或未定价"
          : status >= 500
            ? "计费服务暂不可用，请稍后重试"
            : "计费校验失败";
  return new Response(
    JSON.stringify({
      error: {
        message: safeMessage,
        type: "billing_error",
        code: result.code ?? "nest_billing_error",
      },
    }),
    { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}
