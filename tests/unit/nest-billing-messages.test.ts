import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { runNestPreflight } from "../../src/lib/nestBilling/guard.ts";
import {
  nestCredentialCandidates,
  nestVerifyOnlyEndpoint,
} from "../../src/lib/nestBilling/credentials.ts";
import { estimatePromptTokens } from "../../src/lib/nestBilling/estimate.ts";
import { nestVerifyWithCandidates } from "../../src/lib/nestBilling/preflight.ts";

/**
 * T3.2/T3.3：Claude 协议（/v1/messages）接入边缘计费。
 *
 * 这里覆盖“预检选择/错误体翻译/图片估算/verify-only”这些纯函数层语义；
 * 路由层（handleChat 包装、流式 settle）由 nest-billing-sync/usage/cost 套件
 * 与 T3.7 的 E2E 脚本覆盖。
 */

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

type AnthropicErrorBody = { type?: string; error?: { type?: string; message?: string } };

let captured: Captured[] = [];
let responder: (url: string) => Response;

function installFetchMock(): () => void {
  const original = globalThis.fetch;
  captured = [];
  responder = () =>
    new Response(JSON.stringify({ ticket: "ticket-1", billingRequestId: "req-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const raw = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    captured.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return responder(String(input));
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function messagesRequest(headers: Record<string, string>): Request {
  return new Request("https://gateway.local/v1/messages?beta=true", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-sonnet-4-5-20250929", max_tokens: 64000 }),
  });
}

const baseOpts = {
  endpoint: "/v1/messages",
  requestedModel: "claude-sonnet-4-5-20250929",
  maxTokens: 8192,
  stream: true,
  requestId: "req-fixed-1",
  errorFormat: "anthropic" as const,
};

let restoreFetch: () => void;

beforeEach(() => {
  process.env.NEST_BILLING_ENABLED = "true";
  process.env.NEST_BILLING_BASE_URL = "http://nest.local";
  process.env.NEST_EDGE_SECRET = "edge-secret";
  process.env.NEST_BILLING_TIMEOUT_MS = "2000";
  restoreFetch = installFetchMock();
});

afterEach(() => {
  restoreFetch();
  delete process.env.NEST_BILLING_ENABLED;
  delete process.env.NEST_BILLING_BASE_URL;
  delete process.env.NEST_EDGE_SECRET;
  delete process.env.NEST_BILLING_TIMEOUT_MS;
});

test("x-api-key: sk-nest → 预检使用该 key，endpoint=/v1/messages", async () => {
  const req = messagesRequest({ "x-api-key": "sk-nest-1", "x-real-ip": "9.9.9.9" });
  const outcome = await runNestPreflight(req, { model: baseOpts.requestedModel }, baseOpts);
  assert.equal(outcome.status, "billing");
  assert.equal(captured.length, 1);
  assert.ok(captured[0].url.endsWith("/ai/edge/check"));
  assert.equal(captured[0].headers.authorization, "Bearer sk-nest-1");
  assert.equal(captured[0].headers["x-real-ip"], "9.9.9.9");
  assert.equal(captured[0].body.endpoint, "/v1/messages");
  assert.equal(captured[0].body.model, "claude-sonnet-4-5-20250929");
  if (outcome.status === "billing") {
    assert.equal(outcome.ctx.requestId, "req-fixed-1");
    assert.equal(outcome.ctx.endpoint, "/v1/messages");
    assert.equal(outcome.ctx.billingRequestId, "req-1");
  }
});

test("陈旧 Bearer sk-ant-* + 有效 x-api-key → 只尝试 sk-nest（Anthropic 凭据被排除）", async () => {
  const req = messagesRequest({
    authorization: "Bearer sk-ant-oat-stale",
    "x-api-key": "sk-nest-2",
  });
  assert.deepEqual(nestCredentialCandidates(req), ["sk-nest-2"]);
  const outcome = await runNestPreflight(req, { model: baseOpts.requestedModel }, baseOpts);
  assert.equal(outcome.status, "billing");
  assert.equal(captured[0].headers.authorization, "Bearer sk-nest-2");
});

test("Bearer <JWT> → 也走 nest 预检", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.sig";
  const req = messagesRequest({ authorization: `Bearer ${jwt}` });
  const outcome = await runNestPreflight(req, { model: baseOpts.requestedModel }, baseOpts);
  assert.equal(outcome.status, "billing");
  assert.equal(captured[0].headers.authorization, `Bearer ${jwt}`);
});

test("无 nest 凭据 → skipped（不影响本地 key 流程）", async () => {
  const req = messagesRequest({ authorization: "Bearer or-local-key" });
  const outcome = await runNestPreflight(req, { model: baseOpts.requestedModel }, baseOpts);
  assert.equal(outcome.status, "skipped");
  assert.equal(captured.length, 0);
});

test("402 → Anthropic billing_error 错误体", async () => {
  responder = () =>
    new Response(
      JSON.stringify({ ok: false, reason: "insufficient_balance", message: "余额不足" }),
      {
        status: 402,
        headers: { "content-type": "application/json" },
      }
    );
  const req = messagesRequest({ "x-api-key": "sk-nest-3" });
  const outcome = await runNestPreflight(req, { model: baseOpts.requestedModel }, baseOpts);
  assert.equal(outcome.status, "rejection");
  if (outcome.status === "rejection") {
    assert.equal(outcome.rejection.status, 402);
    const body = (await outcome.rejection.json()) as AnthropicErrorBody;
    assert.equal(body.type, "error");
    assert.equal(body.error?.type, "billing_error");
    assert.equal(outcome.rejection.headers.get("x-should-retry"), "false");
  }
});

test("401/429/503 → Anthropic authentication/rate_limit/api 错误体", async () => {
  const cases: Array<[number, string, string]> = [
    [401, "invalid_token", "authentication_error"],
    [429, "rate_limited", "rate_limit_error"],
    [503, "billing_unavailable", "api_error"],
  ];
  for (const [status, reason, expected] of cases) {
    responder = () =>
      new Response(JSON.stringify({ ok: false, reason, message: reason }), {
        status,
        headers: { "content-type": "application/json", "retry-after": "7" },
      });
    const req = messagesRequest({ "x-api-key": "sk-nest-4" });
    const outcome = await runNestPreflight(req, { model: baseOpts.requestedModel }, baseOpts);
    assert.equal(outcome.status, "rejection");
    if (outcome.status === "rejection") {
      const body = (await outcome.rejection.json()) as AnthropicErrorBody;
      assert.equal(outcome.rejection.status, status);
      assert.equal(body.error?.type, expected);
      if (status === 429) assert.equal(outcome.rejection.headers.get("retry-after"), "7");
    }
  }
});

test("2MB base64 图片的 prompt 估算 ≤ 文本估算 + 1500", () => {
  const base64 = "A".repeat(2 * 1024 * 1024);
  const body = {
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        ],
      },
    ],
  };
  const withoutImage = estimatePromptTokens({
    ...body,
    messages: [{ role: "user", content: [{ type: "text", text: "describe this" }] }],
  });
  const withImage = estimatePromptTokens(body);
  assert.ok(
    withImage <= withoutImage + 1500,
    `withImage=${withImage} withoutImage=${withoutImage}`
  );
});

test("count_tokens 命中 verify-only 白名单（/api 前缀也归一）", () => {
  assert.equal(
    nestVerifyOnlyEndpoint("https://gw.local/v1/messages/count_tokens"),
    "/v1/messages/count_tokens"
  );
  assert.equal(
    nestVerifyOnlyEndpoint("https://gw.local/api/v1/messages/count_tokens"),
    "/v1/messages/count_tokens"
  );
});

test("nestVerify 成功返回 tokenId，失败透传 reason", async () => {
  responder = () =>
    new Response(JSON.stringify({ userId: 7, tokenId: 42 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const ok = await nestVerifyWithCandidates(["sk-nest-5"], {
    model: "claude-sonnet-4-5",
    endpoint: "/v1/messages/count_tokens",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.tokenId, 42);
  assert.ok(captured[0].url.endsWith("/ai/edge/verify"));

  responder = () =>
    new Response(JSON.stringify({ ok: false, reason: "debt_pending", message: "欠费" }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  const denied = await nestVerifyWithCandidates(["sk-nest-6"], {});
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.reason, "debt_pending");
});
