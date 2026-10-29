import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { withNestBilling, type NestBillingContext } from "../../src/lib/nestBilling/response.ts";

/**
 * 计费同步（D4）回归：
 * 五条出口路径（JSON / SSE / abort / 上游 5xx / 上游带 x-request-id）都必须把
 * settle 的 omnirouteRequestId 固定为路由层生成的 ctx.requestId，
 * 即 call_logs.correlation_id，不能被上游响应头或估算逻辑覆盖。
 */

const REQ_ID = "req-fixed-sync-1";

function ctx(overrides: Partial<NestBillingContext> = {}): NestBillingContext {
  return {
    ticket: "ticket-sync-1",
    startedAt: Date.now(),
    model: "agnes-3.0-flash",
    promptTokensEstimate: 10,
    requestId: REQ_ID,
    ...overrides,
  };
}

type SettleBody = {
  omnirouteRequestId?: string;
  traceId?: string;
  aborted?: boolean;
  status?: number;
  usage?: { totalTokens?: number };
};
type CapturedCall = { url: string; body: SettleBody };

function mockSettleFetch(): { calls: CapturedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as SettleBody });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

let captured: ReturnType<typeof mockSettleFetch>;

beforeEach(() => {
  process.env.NEST_BILLING_ENABLED = "true";
  process.env.NEST_BILLING_BASE_URL = "http://nest.local";
  process.env.NEST_EDGE_SECRET = "edge-secret";
  process.env.NEST_BILLING_TIMEOUT_MS = "2000";
  captured = mockSettleFetch();
});

afterEach(() => {
  captured.restore();
  delete process.env.NEST_BILLING_ENABLED;
  delete process.env.NEST_BILLING_BASE_URL;
  delete process.env.NEST_EDGE_SECRET;
  delete process.env.NEST_BILLING_TIMEOUT_MS;
});

test("JSON 路径：omnirouteRequestId === call_logs.correlation_id", async () => {
  const response = new Response(JSON.stringify({ choices: [], usage: USAGE }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text();
  await waitFor(() => captured.calls.length === 1);
  assert.equal(captured.calls[0].body.omnirouteRequestId, REQ_ID);
  assert.equal(captured.calls[0].body.traceId, REQ_ID);
  assert.equal(captured.calls[0].body.usage.totalTokens, 15);
});

test("SSE 路径：流结束后仍使用同一 reqId 结算", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\n`)
      );
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text();
  await waitFor(() => captured.calls.length === 1);
  assert.equal(captured.calls[0].body.omnirouteRequestId, REQ_ID);
  assert.equal(captured.calls[0].body.usage.totalTokens, 15);
});

test("abort 路径：客户端中断也按同一 reqId 结算", async () => {
  const controller = new AbortController();
  const response = new Response(JSON.stringify({ choices: [], usage: USAGE }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  withNestBilling(response, ctx({ signal: controller.signal }));
  controller.abort();
  await waitFor(() => captured.calls.length === 1);
  assert.equal(captured.calls[0].body.omnirouteRequestId, REQ_ID);
  assert.equal(captured.calls[0].body.aborted, true);
});

test("上游 5xx 路径：错误结算仍使用同一 reqId", async () => {
  const response = new Response(JSON.stringify({ error: { message: "upstream boom" } }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text().catch(() => "");
  await waitFor(() => captured.calls.length === 1);
  assert.equal(captured.calls[0].body.omnirouteRequestId, REQ_ID);
  assert.equal(captured.calls[0].body.status, 502);
});

test("上游响应头 x-request-id 不得覆盖路由层 reqId", async () => {
  const response = new Response(JSON.stringify({ choices: [], usage: USAGE }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "upstream-request-id",
      "x-correlation-id": "upstream-correlation-id",
    },
  });
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text();
  await waitFor(() => captured.calls.length === 1);
  assert.equal(captured.calls[0].body.omnirouteRequestId, REQ_ID);
});
