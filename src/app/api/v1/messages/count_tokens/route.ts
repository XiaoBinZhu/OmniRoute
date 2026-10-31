import { CORS_HEADERS } from "@/shared/utils/cors";
import { v1CountTokensSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { countTextTokens, type TokenizerContext } from "@/shared/utils/tiktokenCounter";
import { isRuntimeProviderRetirementError } from "@/shared/constants/providerRetirement";
import { getExecutor } from "@omniroute/open-sse/executors/index.ts";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { isCommonChatGptWebRetirementError } from "@/shared/constants/chatgptWebRetirement";
import { getModelInfo } from "@/sse/services/model";
import { getProviderCredentials } from "@/sse/services/auth";
import { resolveApiKeyUpstreamScope } from "@/shared/utils/apiKeyUpstreamScope";
import { isCredentialDiagnosticSentinel } from "@/sse/services/credentialSentinel";
import { safeResolveProxy } from "@/sse/handlers/chatHelpers";
import * as log from "@/sse/utils/logger";
import { isInputTokenCountPlausible } from "@omniroute/open-sse/utils/usageTracking.ts";
import { enforceClientApiRouteAuth } from "@/shared/utils/clientApiRouteAuth";
import { resolveClientApiKey } from "@/sse/services/clientApiKeyResolver";
import { nestBillingErrorResponse, isNestBillingEnabled } from "@/lib/nestBilling";
import type { NestBillingErrorInput } from "@/lib/nestBilling/response";
import { nestCredentialCandidates, nestVerifyOnlyEndpoint } from "@/lib/nestBilling/credentials";
import { nestVerifyWithCandidates } from "@/lib/nestBilling/preflight";

/**
 * T3.3/N16：nest 令牌的 count_tokens 本地限流（按 tokenId，默认 60 rpm）。
 * 单进程内存桶：OmniRoute 单容器部署下足够；多实例时是“每实例”上限，仍能挡住单点刷量。
 */
const COUNT_TOKENS_WINDOW_MS = 60_000;
const countTokensWindows = new Map<number, { windowStart: number; count: number }>();

function consumeCountTokensQuota(tokenId: number | undefined): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const limit = Math.max(1, Number(process.env.NEST_COUNT_TOKENS_RPM ?? 60) || 60);
  const key = tokenId ?? 0;
  const now = Date.now();
  const win = countTokensWindows.get(key);
  if (!win || now - win.windowStart >= COUNT_TOKENS_WINDOW_MS) {
    countTokensWindows.set(key, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  win.count += 1;
  if (win.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((win.windowStart + COUNT_TOKENS_WINDOW_MS - now) / 1000)
      ),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function anthropicRateLimited(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "请求过于频繁，请稍后重试" },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
        "x-should-retry": "true",
        "retry-after": String(retryAfterSeconds),
      },
    }
  );
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * POST /v1/messages/count_tokens - Hybrid token count response.
 * Uses real provider-side count when supported, falling back to estimation.
 */
export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const validation = validateBody(v1CountTokensSchema, rawBody);
  if (isValidationFailure(validation)) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const body = validation.data;

  const tokenizerContext: TokenizerContext = {
    model: typeof body.model === "string" ? body.model : undefined,
  };
  const estimated = buildEstimatedCountResponse(body, tokenizerContext);
  const requestedModel = typeof body.model === "string" ? body.model : "";

  // T3.3/N16：nest 令牌的 count_tokens —— 只校验不扣费，且只做本地估算（不调用上游计数）。
  const verifyEndpoint = nestVerifyOnlyEndpoint(request.url);
  if (verifyEndpoint && isNestBillingEnabled()) {
    const candidates = nestCredentialCandidates(request);
    if (candidates.length > 0) {
      const localKey = await resolveClientApiKey(request).catch(() => ({ valid: false }));
      if (!localKey.valid) {
        const verified = await nestVerifyWithCandidates(candidates, {
          model: requestedModel,
          endpoint: verifyEndpoint,
          clientIp: request.headers.get("x-real-ip"),
        });
        if (!verified.ok) {
          return nestBillingErrorResponse(verified as NestBillingErrorInput, "anthropic");
        }
        const quota = consumeCountTokensQuota(verified.tokenId);
        if (!quota.allowed) return anthropicRateLimited(quota.retryAfterSeconds);
        return estimated;
      }
    }
  }

  // Defense-in-depth（与其它路由一致）：非 nest 计费路径仍要过路由级鉴权。
  const authRejection = await enforceClientApiRouteAuth(request);
  if (authRejection) return authRejection;

  if (!requestedModel) {
    return estimated;
  }

  try {
    const modelInfo = await getModelInfo(requestedModel);
    if (!modelInfo?.provider || !modelInfo?.model) {
      return estimated;
    }

    // The provider-side count sends the whole conversation upstream, so it must
    // stay inside the caller key's scope exactly like chat: a key that may not
    // reach this model, or none of whose allowed connections serve it, gets the
    // local estimate — never another connection's credential.
    const keyScope = await resolveApiKeyUpstreamScope(request, requestedModel, modelInfo);
    if (!keyScope.permitted) {
      return estimated;
    }

    const credentials = await getProviderCredentials(
      modelInfo.provider,
      null,
      keyScope.allowedConnections,
      modelInfo.model
    );
    if (!credentials || isCredentialDiagnosticSentinel(credentials)) {
      return estimated;
    }

    const executor = await getExecutor(modelInfo.provider);
    // The provider-side count is a real upstream call — it must honor the
    // connection's proxy assignment exactly like chat execution does.
    const proxyInfo = await safeResolveProxy(
      credentials.connectionId,
      undefined,
      modelInfo.provider
    );
    const counted = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      executor?.countTokens?.({
        model: modelInfo.model,
        body,
        credentials,
        log,
      })
    );

    if (
      !counted ||
      !Number.isFinite(counted.input_tokens) ||
      !isInputTokenCountPlausible(counted.input_tokens, body) ||
      // A provider count of 0 for a non-empty request is bogus (#15763).
      (counted.input_tokens === 0 && estimateInputTokens(body, tokenizerContext) > 0)
    ) {
      return estimated;
    }

    return new Response(
      JSON.stringify({
        input_tokens: counted.input_tokens,
        model: modelInfo.model,
        provider: modelInfo.provider,
        source: counted.source || "provider",
      }),
      {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  } catch (error) {
    if (isRuntimeProviderRetirementError(error) || isCommonChatGptWebRetirementError(error)) {
      return new Response(
        JSON.stringify(
          buildErrorBody(error.status, error.message, null, {
            type: "provider_error",
            code: error.code,
          })
        ),
        {
          status: error.status,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        }
      );
    }
    log.debug(
      "COUNT_TOKENS",
      `Falling back to estimate for ${requestedModel}: ${error instanceof Error ? error.message : String(error)}`
    );
    return estimated;
  }
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// Estimate tokens for a single Anthropic content block. Real agentic
// conversations carry most of their tokens in `tool_use` inputs, `tool_result`
// content, and `thinking` blocks — counting only `text` (as before) reported
// near-zero for those messages and silently broke Claude Code's auto-compaction
// (#2337). Image / redacted_thinking blocks are not text-estimable and count 0.
function estimateContentBlockTokens(part, tokenizerContext: TokenizerContext) {
  if (!part || typeof part !== "object") return 0;
  let tokens = 0;
  switch (part.type) {
    case "text":
      if (typeof part.text === "string") tokens += countTextTokens(part.text, tokenizerContext);
      break;
    case "tool_use":
      if (typeof part.name === "string") tokens += countTextTokens(part.name, tokenizerContext);
      if (part.input !== undefined)
        tokens += countTextTokens(safeStringify(part.input), tokenizerContext);
      break;
    case "tool_result":
      tokens += estimateToolResultTokens(part.content, tokenizerContext);
      break;
    case "thinking":
      if (typeof part.thinking === "string")
        tokens += countTextTokens(part.thinking, tokenizerContext);
      break;
    default:
      break;
  }
  return tokens;
}

// A `tool_result` content can be a plain string or an array of nested blocks
// (text / image). Count string content and nested text blocks.
function estimateToolResultTokens(content, tokenizerContext: TokenizerContext) {
  if (typeof content === "string") return countTextTokens(content, tokenizerContext);
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        tokens += countTextTokens(block.text, tokenizerContext);
      }
    }
    return tokens;
  }
  return 0;
}

function estimateInputTokens(body, tokenizerContext: TokenizerContext = {}): number {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let inputTokens = 0;

  for (const msg of messages) {
    if (typeof msg?.content === "string") {
      inputTokens += countTextTokens(msg.content, tokenizerContext);
      continue;
    }

    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        inputTokens += estimateContentBlockTokens(part, tokenizerContext);
      }
    }
  }

  if (typeof body?.system === "string") {
    inputTokens += countTextTokens(body.system, tokenizerContext);
  } else if (Array.isArray(body?.system)) {
    for (const block of body.system) {
      if (block?.type === "text" && typeof block.text === "string") {
        inputTokens += countTextTokens(block.text, tokenizerContext);
      }
    }
  }

  return inputTokens;
}

function buildEstimatedCountResponse(body, tokenizerContext: TokenizerContext = {}) {
  const inputTokens = estimateInputTokens(body, tokenizerContext);
  return new Response(
    JSON.stringify({
      input_tokens: inputTokens,
      source: "local",
    }),
    {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    }
  );
}
