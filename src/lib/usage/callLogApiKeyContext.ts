import { AsyncLocalStorage } from "node:async_hooks";

export interface CallLogApiKeyContext {
  apiKeyId: string | null;
  apiKeyName: string | null;
  /**
   * Provider connection selected for this attempt. Optional: modal handlers
   * that already pass `connectionId` on the entry keep precedence.
   */
  connectionId?: string | null;
  /** T5.1：与 nest 日志一致的 correlationId（成本回填用）；entry.correlationId 优先 */
  correlationId?: string | null;
}

const callLogApiKeyContext = new AsyncLocalStorage<CallLogApiKeyContext>();

/**
 * Bind API-key (and connection) attribution to every call log emitted by one request.
 *
 * Modal handlers fan out into provider-specific helpers that write their own
 * call logs. Request-scoped storage keeps that attribution available without
 * threading identity parameters through every provider handler.
 */
export function runWithCallLogApiKeyContext<TResult>(
  context: CallLogApiKeyContext,
  callback: () => TResult
): TResult {
  return callLogApiKeyContext.run(context, callback);
}

export function getCallLogApiKeyContext(): CallLogApiKeyContext | null {
  return callLogApiKeyContext.getStore() ?? null;
}
