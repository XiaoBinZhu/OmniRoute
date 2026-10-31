import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { getRequestedModelEndpointMismatch } from "@/lib/providerModels/modelEndpointGuard";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  createComboTargetKeyGate,
  resolveKeyConnectionScope,
} from "@/sse/services/keyConnectionScope";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { v1EmbeddingsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

import { createEmbeddingResponse, type EmbeddingHandlerOptions } from "@/lib/embeddings/service";
import { resolveClientApiKey } from "@/sse/services/clientApiKeyResolver";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { getSpecialtyModelsResponse } from "@/app/api/v1/_shared/specialtyCatalog";
import { generateRequestId } from "@/shared/utils/requestId";
import { resolveIncomingCorrelationId } from "@/shared/utils/correlationPreserve.ts";
import { nestSettle, withNestBilling, type NestBillingContext } from "@/lib/nestBilling";
import { nestAbortSettleInput, runNestPreflight } from "@/lib/nestBilling/guard";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function GET(request?: Request) {
  return getSpecialtyModelsResponse(
    request,
    "/v1/embeddings",
    (model) => model.type === "embedding"
  );
}

type ValidatedEmbeddingBody = Record<string, unknown> & { model: string };

export async function handleValidatedEmbeddingRequestBody(
  body: ValidatedEmbeddingBody,
  options: EmbeddingHandlerOptions = {}
) {
  return createEmbeddingResponse(body, options);
}

async function postHandler(request, context) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    log.warn("EMBED", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1EmbeddingsSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;

  // T4.1 批 2：Embeddings 接入边缘计费（nest 凭据优先预检；本地 key 有效时 skipped）
  let nestCtx: NestBillingContext | null = null;
  const outcome = await runNestPreflight(request, body, {
    endpoint: "/v1/embeddings",
    requestedModel: body.model,
    // 嵌入无输出 token，maxTokens 仅用于满足预扣估算（实际结算读 usage）
    maxTokens: 1,
    stream: false,
    requestId:
      resolveIncomingCorrelationId(request.headers.get("x-correlation-id")) ?? generateRequestId(),
    idempotencyKey: request.headers.get("x-idempotency-key"),
    clientIp: request.headers.get("x-real-ip"),
    errorFormat: "openai",
  });
  if (outcome.status === "rejection") return outcome.rejection;
  if (outcome.status === "billing") nestCtx = outcome.ctx;

  try {
    // Auth check — when REQUIRE_API_KEY=false, ignore presented invalid keys
    // so anonymous access works the same as all other client APIs (#7785).
    // nest 凭据已由预检（含令牌限制）校验，不再走本地 key 判定。
    const { apiKey: apiKeyRaw, valid: apiKeyValid } = await resolveClientApiKey(request);
    if (!nestCtx) {
      if (isRequireApiKeyEnabled() && !apiKeyRaw) {
        return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Authentication required");
      }
      if (isRequireApiKeyEnabled() && apiKeyRaw && !apiKeyValid) {
        return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
      }
    }

    // Enforce API key policies (model restrictions + budget limits); nest 路径由 nest 自身限额
    const policy = nestCtx
      ? { rejection: null, apiKeyInfo: null }
      : await enforceApiKeyPolicy(request, body.model);
    if (policy.rejection) return policy.rejection;
    // GHSA-3w2r: credential selection (direct and per combo target) stays inside
    // the key's connection scope, the same scope chat applies.
    const scope = nestCtx
      ? { rejection: null, allowedConnections: undefined }
      : await resolveKeyConnectionScope(policy.apiKeyInfo);
    if (scope.rejection) return scope.rejection;
    // Respect the authenticated API key's credential scope before checking model capabilities.
    const endpointMismatch = await getRequestedModelEndpointMismatch(body.model, "embeddings");
    if (endpointMismatch) return errorResponse(HTTP_STATUS.BAD_REQUEST, endpointMismatch);

    // Extract API key info for logging
    const apiKeyMeta = policy.apiKeyInfo;

    // Build client raw request for logging
    const clientRawRequest = {
      endpoint: "/v1/embeddings",
      body: rawBody,
      headers: Object.fromEntries(request.headers.entries()),
    };

    const response = await handleValidatedEmbeddingRequestBody(body as ValidatedEmbeddingBody, {
      clientRawRequest,
      apiKeyId: apiKeyMeta?.id || null,
      apiKeyName: apiKeyMeta?.name || null,
      connectionId: null,
      allowedConnections: scope.allowedConnections,
      isComboTargetAllowed: nestCtx ? undefined : createComboTargetKeyGate(policy, body.model),
    });
    return withNestBilling(response, nestCtx);
  } catch (error) {
    if (nestCtx) {
      void nestSettle(nestAbortSettleInput(nestCtx, error));
    }
    throw error;
  }
}

export const POST = withInjectionGuard(postHandler);
