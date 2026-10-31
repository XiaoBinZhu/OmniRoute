import { handleModeration } from "@omniroute/open-sse/handlers/moderations.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { parseModerationModel } from "@omniroute/open-sse/config/moderationRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { generateRequestId } from "@/shared/utils/requestId";
import { resolveIncomingCorrelationId } from "@/shared/utils/correlationPreserve.ts";
import { type NestBillingContext } from "@/lib/nestBilling";
import { runNestPreflight } from "@/lib/nestBilling/guard";
import { rememberNestCtx, withNestFinalize } from "@/lib/nestBilling/finalize";
import {
  isKeyScopeBlockedCredentials,
  keyScopeBlockedResponse,
  resolveKeyConnectionScope,
} from "@/sse/services/keyConnectionScope";
import { v1ModerationSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/moderations — content moderation
 * OpenAI Moderations API compatible.
 */
async function postHandler(request, context) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1ModerationSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  const model = body.model || "omni-moderation-latest";

  // T4.1 批 2：Moderations 接入边缘计费（无 usage 时按 prompt 估算结算）
  let nestCtx: NestBillingContext | null = null;
  const outcome = await runNestPreflight(request, body, {
    endpoint: "/v1/moderations",
    requestedModel: model,
    maxTokens: 1,
    stream: false,
    requestId:
      resolveIncomingCorrelationId(request.headers.get("x-correlation-id")) ?? generateRequestId(),
    idempotencyKey: request.headers.get("x-idempotency-key"),
    clientIp: request.headers.get("x-real-ip"),
    errorFormat: "openai",
  });
  if (outcome.status === "rejection") return outcome.rejection;
  if (outcome.status === "billing") {
    nestCtx = outcome.ctx;
    rememberNestCtx(request, nestCtx);
  }

  try {
    // Enforce API key policies (model restrictions + budget limits); nest 路径由 nest 自身限额
    const policy = nestCtx
      ? { rejection: null, apiKeyInfo: null }
      : await enforceApiKeyPolicy(request, model);
    if (policy.rejection) return policy.rejection;
    // GHSA-3w2r: credential selection stays inside the key's connection scope,
    // the same scope chat applies.
    const scope = nestCtx
      ? { rejection: null, allowedConnections: undefined }
      : await resolveKeyConnectionScope(policy.apiKeyInfo);
    if (scope.rejection) return scope.rejection;

    const { provider } = parseModerationModel(model);

    // Default to openai if no provider prefix
    const resolvedProvider = provider || "openai";
    const credentials = await getProviderCredentialsWithQuotaPreflight(
      resolvedProvider,
      null,
      scope.allowedConnections
    );
    if (!credentials) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials for provider: ${resolvedProvider}`
      );
    }
    if (isKeyScopeBlockedCredentials(credentials)) {
      return keyScopeBlockedResponse(resolvedProvider, credentials);
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(resolvedProvider, credentials);
    }

    const response = await handleModeration({ body: { ...body, model }, credentials });
    if (response?.ok) {
      await clearRecoveredProviderState(credentials as Record<string, unknown>);
    }
    return response;
  } catch (error) {
    // 异常统一由 withNestFinalize 退款（不在此处 settle，避免重复请求）
    throw error;
  }
}

export const POST = withNestFinalize(withInjectionGuard(postHandler));
