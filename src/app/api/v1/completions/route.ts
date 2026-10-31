import { CORS_HEADERS } from "@/shared/utils/cors";
import { buildClientRawRequest, handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { createInjectionGuard } from "@/middleware/promptInjectionGuard";
import { asTextCompletionResponse } from "./textCompletionTransform.ts";
import {
  readCompressionRequestHeader,
  withCompressionHeaderEcho,
} from "@/shared/utils/compressionHeaderEcho";
import { withChatAdmission } from "@/shared/middleware/withChatAdmission";
import { enforceClientApiRouteAuth } from "@/shared/utils/clientApiRouteAuth";
import { generateRequestId } from "@/shared/utils/requestId";
import { resolveIncomingCorrelationId } from "@/shared/utils/correlationPreserve.ts";
import { nestSettle, withNestBilling, type NestBillingContext } from "@/lib/nestBilling";
import { nestAbortSettleInput, runNestPreflight } from "@/lib/nestBilling/guard";
import { edgeEstimateCompletionCap } from "@/lib/nestBilling/config";

let initPromise = null;
// `logger: null` — the guardrail registry re-evaluates this request inside
// handleChat with the pino logger (#11936 dedupe).
const injectionGuard = createInjectionGuard({ logger: null });

function ensureInitialized() {
  if (!initPromise) {
    initPromise = Promise.resolve(initTranslators()).then(() => {
      console.log("[SSE] Translators initialized");
    });
  }
  return initPromise;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/completions — Legacy OpenAI Completions API
 *
 * Accepts both the modern chat format (messages[]) and the legacy
 * text-completions format (prompt string). Legacy requests are
 * automatically normalized to chat/completions format before routing.
 *
 * @see https://platform.openai.com/docs/api-reference/completions
 */
async function postHandler(request: Request) {
  // Defense-in-depth: the authz proxy (src/proxy.ts) is the primary gate, but
  // its matcher can miss path variants (e.g. uppercase /V1/ aliases), so the
  // handler enforces authentication independently.
  const authRejection = await enforceClientApiRouteAuth(request);
  if (authRejection) return authRejection;

  await ensureInitialized();

  // #6422 — capture the compression request header once so we can echo it back
  // on the response when internal early-returns drop the meta the docs promise.
  const compressionRequestHeader = readCompressionRequestHeader(request);

  let nestCtx: NestBillingContext | null = null;
  try {
    // Parse once for injection guard + nest billing (the request is cloned, never consumed).
    let body: any = null;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }

    if (body) {
      const { blocked, result } = injectionGuard(body);
      if (blocked) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Request blocked: potential prompt injection detected",
              type: "injection_detected",
              code: "SECURITY_001",
              detections: result.detections.length,
            },
          }),
          { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }
    }

    // T4.1 批 1：Legacy Completions 接入边缘计费（原始名/端点/上限与 chat 同口径）
    const requestedModel = typeof body?.model === "string" ? body.model.trim() : "";
    const declaredMax = Number(body?.max_tokens ?? body?.max_completion_tokens ?? 0);
    const outcome = await runNestPreflight(request, body, {
      endpoint: "/v1/completions",
      requestedModel,
      maxTokens: Math.min(
        Number.isFinite(declaredMax) && declaredMax > 0 ? Math.floor(declaredMax) : 4096,
        edgeEstimateCompletionCap()
      ),
      stream: body?.stream === true,
      requestId:
        resolveIncomingCorrelationId(request.headers.get("x-correlation-id")) ??
        generateRequestId(),
      idempotencyKey: request.headers.get("x-idempotency-key"),
      clientIp: request.headers.get("x-real-ip"),
      errorFormat: "openai",
    });
    if (outcome.status === "rejection") return outcome.rejection;
    if (outcome.status === "billing") nestCtx = outcome.ctx;

    // Normalize legacy completions format: { prompt, model } → { messages, model }
    if (body && body.prompt !== undefined && !body.messages) {
      const prompt = Array.isArray(body.prompt) ? body.prompt.join("\n") : String(body.prompt);
      const normalized = {
        ...body,
        messages: [{ role: "user", content: prompt }],
      };
      delete normalized.prompt;

      const newRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(normalized),
        signal: request.signal,
      });
      // #3571 — translate the chat-pipeline response back to the legacy
      // text-completion shape so OpenAI Completion clients (e.g. TabbyML) work.
      const raw = await handleChat(newRequest, () => buildClientRawRequest(request, body));
      return withCompressionHeaderEcho(
        await asTextCompletionResponse(
          withNestBilling(raw, nestCtx),
          typeof body.model === "string" ? body.model : undefined
        ),
        compressionRequestHeader
      );
    }

    // Standard path: body already has messages[] (chat format). Still emit the legacy
    // text-completion shape — this is the /v1/completions contract (#3571).
    const raw = await handleChat(request);
    return withCompressionHeaderEcho(
      await asTextCompletionResponse(withNestBilling(raw, nestCtx), requestedModel || undefined),
      compressionRequestHeader
    );
  } catch (error) {
    if (nestCtx) {
      void nestSettle(nestAbortSettleInput(nestCtx, error));
    }
    throw error;
  }
}

export const POST = withChatAdmission(postHandler);
