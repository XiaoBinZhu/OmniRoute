/**
 * nest 计费预检的统一入口（T3.1）。
 *
 * chat/completions 与 /v1/messages 共用「预检 → 构造 NestBillingContext」这段逻辑；
 * 抽出来是为了让两条路由的凭据优先级、fail-closed 形态与错误体翻译完全一致，
 * 不再各抄一份。
 *
 * 优先级（与 chat 路由改造前一致）：
 * 1. nest 计费未启用 → skipped；
 * 2. 请求没有 nest 候选凭据（`sk-` 令牌或 C 端 JWT）→ skipped；
 * 3. OmniRoute 自有 key 校验通过 → skipped（本地 key 优先，保持原行为）；
 * 4. 否则必须预检成功，失败即返回可直接下发的 rejection（OpenAI/Anthropic 错误体）。
 *
 * @module lib/nestBilling/guard
 */

import { createHash } from "node:crypto";

import { resolveClientApiKey } from "@/sse/services/clientApiKeyResolver";

import { isNestBillingEnabled } from "./config";
import { nestCredentialCandidates } from "./credentials";
import { nestPreflightShapeRejection, preflightWithCandidates } from "./preflight";
import {
  nestBillingErrorResponse,
  type NestBillingContext,
  type NestBillingErrorInput,
} from "./response";

export interface RunNestPreflightOptions {
  /** 规范化后的端点（`/v1/chat/completions`、`/v1/messages`） */
  endpoint: string;
  /** 用户发送的原始模型名（别名解析之前；nest 侧负责别名/日期后缀） */
  requestedModel: string;
  /** 预扣估算的输出上限（调用方已按 EDGE_ESTIMATE_COMPLETION_CAP 截断） */
  maxTokens: number;
  /** 调用方传入会跳过重复估算；缺省时按 body 估算（T2.3） */
  promptTokensEstimate?: number;
  stream: boolean;
  /** = call_logs.correlation_id；settle 时回传保证两边可关联 */
  requestId: string;
  /** 请求体摘要；缺省时按 body JSON 计算 */
  bodyDigest?: string;
  idempotencyKey?: string | null;
  /** T2.2：宿主 nginx 注入的 x-real-ip */
  clientIp?: string | null;
  /** 错误体格式（/v1/messages 用 anthropic） */
  errorFormat?: "openai" | "anthropic";
}

export type RunNestPreflightOutcome =
  | { status: "billing"; ctx: NestBillingContext }
  | { status: "rejection"; rejection: Response }
  | { status: "skipped" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 估算 promptTokens 的延迟导入：避免 guard 与 estimate 的循环依赖风险 */
async function resolvePromptTokens(
  body: Record<string, unknown>,
  provided: number | undefined
): Promise<number> {
  if (typeof provided === "number" && Number.isFinite(provided) && provided > 0) {
    return Math.floor(provided);
  }
  const { estimatePromptTokens } = await import("./estimate");
  return estimatePromptTokens(body);
}

/**
 * 执行一次 nest 预检（含候选 401 重试）。
 *
 * `body` 允许任意 JSON 形态：非对象时走 N4 的 400（有 nest 凭据就绝不裸奔到上游）。
 */
export async function runNestPreflight(
  request: Request,
  body: unknown,
  opts: RunNestPreflightOptions
): Promise<RunNestPreflightOutcome> {
  if (!isNestBillingEnabled()) return { status: "skipped" };

  const candidates = nestCredentialCandidates(request);
  if (candidates.length === 0) return { status: "skipped" };

  // OmniRoute 自有 key 优先：它已经通过本地策略（额度/白名单/限流），无需 nest 预检。
  const localKey = await resolveClientApiKey(request).catch(() => ({ valid: false }));
  if (localKey.valid) return { status: "skipped" };

  const shapeRejection = nestPreflightShapeRejection({
    parsedBodyIsRecord: isRecord(body),
    model: opts.requestedModel,
  });
  if (shapeRejection) {
    const { status, message } = shapeRejection;
    return {
      status: "rejection",
      rejection: nestBillingErrorResponse({ status, message }, opts.errorFormat ?? "openai"),
    };
  }

  const record = body as Record<string, unknown>;
  const promptTokensEstimate = await resolvePromptTokens(record, opts.promptTokensEstimate);
  const bodyDigest =
    opts.bodyDigest ?? createHash("sha256").update(JSON.stringify(record)).digest("hex");

  const preflight = await preflightWithCandidates(candidates, {
    model: opts.requestedModel,
    stream: opts.stream,
    maxTokens: opts.maxTokens,
    promptTokens: promptTokensEstimate,
    bodyDigest,
    idempotencyKey: opts.idempotencyKey ?? null,
    // T2.2：未显式传时读宿主 nginx 注入的 x-real-ip
    clientIp: opts.clientIp ?? request.headers.get("x-real-ip"),
    endpoint: opts.endpoint,
  });
  if (!preflight.ok) {
    return {
      status: "rejection",
      rejection: nestBillingErrorResponse(
        preflight as NestBillingErrorInput,
        opts.errorFormat ?? "openai"
      ),
    };
  }

  return {
    status: "billing",
    ctx: {
      ticket: preflight.ticket,
      startedAt: Date.now(),
      model: opts.requestedModel,
      promptTokensEstimate,
      signal: request.signal,
      requestId: opts.requestId,
      billingRequestId: preflight.billingRequestId ?? null,
      endpoint: opts.endpoint,
    },
  };
}

/**
 * 供路由 catch 分支复用：预检成功后上游抛错时补一次 settle（status=500）。
 * 不在此模块直接依赖 nestSettle，避免把结算副作用藏进“构建上下文”的函数里。
 */
export function nestAbortSettleInput(
  ctx: NestBillingContext,
  error: unknown
): {
  ticket: string;
  status: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
  error: string;
  upstreamModel: string;
  omnirouteRequestId: string | null;
  traceId: string | null;
  billingRequestId: string | null;
  endpoint: string;
} {
  return {
    ticket: ctx.ticket,
    status: 500,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    durationMs: Date.now() - ctx.startedAt,
    error: (error as Error)?.message ?? String(error),
    upstreamModel: ctx.model,
    omnirouteRequestId: ctx.requestId ?? null,
    traceId: ctx.requestId ?? null,
    billingRequestId: ctx.billingRequestId ?? null,
    endpoint: ctx.endpoint ?? "/v1/chat/completions",
  };
}
