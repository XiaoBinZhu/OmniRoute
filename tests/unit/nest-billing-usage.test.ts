import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { estimatePromptTokens, IMAGE_TOKEN_ESTIMATE } from "../../src/lib/nestBilling/estimate.ts";
import { withNestBilling, type NestBillingContext } from "../../src/lib/nestBilling/response.ts";
import { UsageAccumulator } from "../../src/lib/nestBilling/usageAccumulator.ts";

/**
 * T2.3 用量解析矩阵（计划 §T2.3 的 12 项）。
 * 直接用累加器断言合并语义，再用 withNestBilling 断言 settle 上报。
 */

function accOf(events: unknown[]) {
  const acc = new UsageAccumulator();
  for (const event of events) acc.feed(event);
  return acc.result();
}

type SettleBody = {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheWrite1hTokens?: number;
    promptIncludesCache?: boolean;
  };
  status?: number;
  aborted?: boolean;
  usageProvenance?: string;
  billingRequestId?: string;
  endpoint?: string;
};

function mockSettle(): { calls: SettleBody[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: SettleBody[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as SettleBody);
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
    ticket: "t2-3",
    startedAt: Date.now(),
    model: "claude-sonnet-4-5",
    promptTokensEstimate: 1200,
    requestId: "req-t2-3",
    billingRequestId: "bill-t2-3",
    endpoint: "/v1/messages",
    ...overrides,
  };
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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

test("#1 Anthropic 原生流：message_start 带 input/cache，1h 缓存对象形态", () => {
  const usage = accOf([
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 1200,
          cache_read_input_tokens: 800,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
        },
      },
    },
    { type: "message_delta", usage: { output_tokens: 300 } },
  ]);
  assert.equal(usage.promptTokens, 1200);
  assert.equal(usage.completionTokens, 300);
  assert.equal(usage.cacheReadTokens, 800);
  assert.equal(usage.cacheWriteTokens, 100);
  assert.equal(usage.cacheWrite1hTokens, 50);
  assert.equal(usage.promptIncludesCache, false);
  assert.equal(usage.totalTokens, 1500);
});

test("#2 Anthropic 流：message_delta 只有 output → prompt 不被覆盖为 0", () => {
  const usage = accOf([
    { message: { usage: { input_tokens: 900, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 220 } },
  ]);
  assert.equal(usage.promptTokens, 900);
  assert.equal(usage.completionTokens, 220);
});

test("#3 OpenAI 流 + include_usage：cached_tokens 计入 prompt → promptIncludesCache=true", () => {
  const usage = accOf([
    {
      choices: [{ delta: { content: "hi" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 600 },
      },
    },
  ]);
  assert.equal(usage.promptTokens, 1000);
  assert.equal(usage.cacheReadTokens, 600);
  assert.equal(usage.promptIncludesCache, true);
});

test("#4 OpenAI 非流 JSON：同 #3", () => {
  const usage = accOf([
    {
      choices: [{ message: { content: "hello" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 600 },
      },
    },
  ]);
  assert.equal(usage.promptIncludesCache, true);
  assert.equal(usage.cacheReadTokens, 600);
});

test("#5 Anthropic 非流 JSON（cache_creation 对象）", () => {
  const usage = accOf([
    {
      type: "message",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 },
      },
    },
  ]);
  assert.equal(usage.cacheWriteTokens, 3);
  assert.equal(usage.cacheWrite1hTokens, 2);
  assert.equal(usage.promptIncludesCache, false);
});

test("#6 客户端中断且无 usage → 走估算 + aborted=true + usageProvenance=estimated_abort", async () => {
  const controller = new AbortController();
  const response = sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "a".repeat(400) } }] })}\n\n`,
  ]);
  const wrapped = withNestBilling(response, ctx({ signal: controller.signal }));
  void wrapped.text().catch(() => "");
  controller.abort();
  await waitFor(() => mocked.calls.length === 1);
  const body = mocked.calls[0];
  assert.equal(body.aborted, true);
  assert.equal(body.usageProvenance, "estimated_abort");
  assert.ok((body.usage?.promptTokens ?? 0) >= 1200);
  assert.equal(body.billingRequestId, "bill-t2-3");
  assert.equal(body.endpoint, "/v1/messages");
});

test("#7 每个 chunk 重复带全量 usage → 取 max，不膨胀", () => {
  const full = {
    prompt_tokens: 500,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 100 },
  };
  const usage = accOf([{ usage: full }, { usage: full }, { usage: full }]);
  assert.equal(usage.promptTokens, 500);
  assert.equal(usage.completionTokens, 10);
  assert.equal(usage.cacheReadTokens, 100);
});

test("#8 OpenAI Responses：input_tokens + input_tokens_details.cached_tokens → promptIncludesCache=true", () => {
  const usage = accOf([
    {
      response: {
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 600 },
        },
      },
    },
  ]);
  assert.equal(usage.promptTokens, 1000);
  assert.equal(usage.cacheReadTokens, 600);
  assert.equal(usage.promptIncludesCache, true);
});

test("#9 慢路径后只收到 error 帧 → status>=400，nest 退款路径", async () => {
  const response = sseResponse([
    `event: error\ndata: ${JSON.stringify({ error: { message: "upstream 500", code: 500 } })}\n\n`,
  ]);
  const wrapped = withNestBilling(response, ctx());
  await wrapped.text();
  await waitFor(() => mocked.calls.length === 1);
  assert.ok((mocked.calls[0].status ?? 0) >= 400);
  assert.equal(mocked.calls[0].usage?.completionTokens, 0);
});

test("#10 Claude 流中断，已流出 400 字符 → completion 用 tokenizer 计数，不按预扣 8192", async () => {
  const text = "x".repeat(400);
  const response = sseResponse([
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`,
  ]);
  const controller = new AbortController();
  const wrapped = withNestBilling(response, ctx({ signal: controller.signal }));
  // 先读到一个 chunk 确保 transform 已处理该帧（内容已累计），再中断
  const reader = wrapped.body!.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => {});
  await waitFor(() => mocked.calls.length === 1);
  const completion = mocked.calls[0].usage?.completionTokens ?? -1;
  assert.ok(completion > 1 && completion < 8192, `completion=${completion}`);
  assert.equal(mocked.calls[0].usageProvenance, "estimated_abort");
  assert.equal(mocked.calls[0].aborted, true);
});

test("#11 2MB base64 图片：预扣估算 ≤ 文本估算 + 1500", () => {
  const image = "A".repeat(2 * 1024 * 1024);
  const body = {
    model: "vision-model",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: image } },
        ],
      },
    ],
  };
  const estimate = estimatePromptTokens(body);
  assert.ok(estimate <= 2000 + IMAGE_TOKEN_ESTIMATE, `estimate=${estimate}`);
});

test("#12 total_tokens = prompt + completion（不取 max）", () => {
  const usage = accOf([
    { message: { usage: { input_tokens: 100, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 50, total_tokens: 999999 } },
  ]);
  assert.equal(usage.totalTokens, 150);
});
