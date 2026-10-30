import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { withNestBilling, type NestBillingContext } from "../../src/lib/nestBilling/response.ts";

/**
 * T2.4 / N11：上游成本与实际路由模型的采集。
 * - 非流式：响应头 `X-OmniRoute-Response-Cost/Model/Provider`
 * - 流式：元信息以 SSE 注释行下发（`: x-omniRoute-response-cost=…`）
 * - 未定价：不得传 `upstreamCost: 0`（否则毛利显示 100% 并掩盖 cost_pending）
 */

type Body = {
  upstreamCost?: number;
  upstreamModel?: string;
  upstreamProvider?: string;
  usage?: { promptTokens?: number };
};

function mockSettle(): { calls: Body[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Body[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Body);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function ctx(overrides: Partial<NestBillingContext> = {}): NestBillingContext {
  return {
    ticket: "t2-4",
    startedAt: Date.now(),
    model: "gpt-4o-mini",
    promptTokensEstimate: 100,
    requestId: "req-t2-4",
    ...overrides,
  };
}

let mocked: ReturnType<typeof mockSettle>;

beforeEach(() => {
  process.env.NEST_BILLING_ENABLED = "true";
  process.env.NEST_BILLING_BASE_URL = "http://nest.local";
  process.env.NEST_EDGE_SECRET = "edge-secret";
  process.env.NEST_BILLING_TIMEOUT_MS = "2000";
  mocked = mockSettle();
});

afterEach(() => {
  mocked.restore();
  delete process.env.NEST_BILLING_ENABLED;
  delete process.env.NEST_BILLING_BASE_URL;
  delete process.env.NEST_EDGE_SECRET;
  delete process.env.NEST_BILLING_TIMEOUT_MS;
});

test("非流式：响应头带成本/实际模型/供应商 → settle 上报", async () => {
  const response = new Response(
    JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-omniroute-response-cost": "0.0000123456",
        "x-omniroute-model": "gpt-4o-mini-2024-07-18",
        "x-omniroute-provider": "openai",
      },
    }
  );
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text();
  await waitFor(() => mocked.calls.length === 1);
  assert.equal(mocked.calls[0].upstreamCost, 0.0000123456);
  assert.equal(mocked.calls[0].upstreamModel, "gpt-4o-mini-2024-07-18");
  assert.equal(mocked.calls[0].upstreamProvider, "openai");
});

test("流式：SSE 注释行里的成本/模型被解析", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = (text: string) => new TextEncoder().encode(text);
      controller.enqueue(
        encode(
          [
            ": x-omniroute-response-cost=0.0000200000",
            ": x-omniroute-model=claude-sonnet-4-5-20250929",
            ": x-omniroute-provider=anthropic",
            `data: ${JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 20 } })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n")
        )
      );
      controller.close();
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const wrapped = withNestBilling(response, ctx({ model: "claude-sonnet-4-5" }));
  await wrapped.text();
  await waitFor(() => mocked.calls.length === 1);
  assert.equal(mocked.calls[0].upstreamCost, 0.00002);
  assert.equal(mocked.calls[0].upstreamModel, "claude-sonnet-4-5-20250929");
  assert.equal(mocked.calls[0].upstreamProvider, "anthropic");
});

test("无成本头且供应商未知 → 不传 upstreamCost（保持 cost_pending）", async () => {
  const response = new Response(
    JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text();
  await waitFor(() => mocked.calls.length === 1);
  assert.equal(mocked.calls[0].upstreamCost, undefined);
  assert.equal(mocked.calls[0].upstreamModel, "gpt-4o-mini");
});

test("成本头为 0（未定价/免费）→ 不当作已定价上报", async () => {
  const response = new Response(
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    {
      status: 200,
      headers: { "content-type": "application/json", "x-omniroute-response-cost": "0.0000000000" },
    }
  );
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text();
  await waitFor(() => mocked.calls.length === 1);
  assert.equal(mocked.calls[0].upstreamCost, undefined);
});
