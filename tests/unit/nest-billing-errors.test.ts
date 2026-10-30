import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { nestPreflight, type NestPreflightResult } from "../../src/lib/nestBilling/client.ts";
import {
  nestBillingErrorResponse,
  resolveBillingErrorMapping,
} from "../../src/lib/nestBilling/response.ts";

/**
 * T1.4 / N5：nest 的 `reason` 契约 → HTTP 码 / 错误体 / x-should-retry。
 * 余额不足必须是 402（不能是 429，否则 SDK 自动重试）；nest 不可达是 503。
 */

const REASONS: Array<[string, number, boolean]> = [
  ["invalid_token", 401, false],
  ["token_forbidden", 403, false],
  ["token_frozen", 403, false],
  ["ip_not_allowed", 403, false],
  ["model_not_found", 404, false],
  ["model_unpriced", 404, false],
  ["group_not_allowed", 403, false],
  ["insufficient_balance", 402, false],
  ["quota_exhausted", 402, false],
  ["parent_quota_exhausted", 402, false],
  ["debt_pending", 402, false],
  ["usage_limit_exceeded", 429, true],
  ["rate_limited", 429, true],
  ["concurrency_limit_exceeded", 429, true],
  ["billing_unavailable", 503, true],
];

function failure(
  reason: string,
  status: number,
  retryAfterSeconds?: number
): Extract<NestPreflightResult, { ok: false }> {
  return { ok: false, status, message: reason, reason, retryAfterSeconds };
}

test("每个 reason 映射到固定 HTTP 码与 x-should-retry", () => {
  for (const [reason, status, shouldRetry] of REASONS) {
    const mapping = resolveBillingErrorMapping(reason, 500);
    assert.equal(mapping.status, status, `${reason} 状态码`);
    assert.equal(mapping.shouldRetry, shouldRetry, `${reason} x-should-retry`);
  }
});

test("OpenAI 错误体：402 + billing_error + 稳定 code", async () => {
  const response = nestBillingErrorResponse(failure("insufficient_balance", 402));
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("x-should-retry"), "false");
  const body = (await response.json()) as {
    error: { type: string; code: string; message: string };
  };
  assert.equal(body.error.type, "billing_error");
  assert.equal(body.error.code, "insufficient_balance");
  assert.match(body.error.message, /余额不足/);
});

test("Anthropic 错误体：type=error + error.type + 401", async () => {
  const response = nestBillingErrorResponse(failure("invalid_token", 401), "anthropic");
  assert.equal(response.status, 401);
  const body = (await response.json()) as {
    type: string;
    error: { type: string; message: string };
  };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "authentication_error");
});

test("限流类 429：透传 Retry-After 且允许重试", async () => {
  const response = nestBillingErrorResponse(failure("rate_limited", 429, 12.4));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("x-should-retry"), "true");
  assert.equal(response.headers.get("Retry-After"), "13");
});

test("未知 reason 按状态码兜底（402 → 余额不足，500 → 503 api_error）", () => {
  assert.equal(resolveBillingErrorMapping("totally_new_reason", 402).status, 402);
  assert.equal(resolveBillingErrorMapping(undefined, 500).status, 503);
  assert.equal(resolveBillingErrorMapping("totally_new_reason", 404).status, 404);
});

test("nest 不可达 → 503 billing_unavailable（N15）", async () => {
  const original = globalThis.fetch;
  const previousEnabled = process.env.NEST_BILLING_ENABLED;
  const previousBase = process.env.NEST_BILLING_BASE_URL;
  process.env.NEST_BILLING_ENABLED = "1";
  process.env.NEST_BILLING_BASE_URL = "http://nest.local";
  try {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const result = await nestPreflight({ key: "sk-x", model: "m", stream: false });
    assert.equal(result.ok, false);
    const failed = result as Extract<NestPreflightResult, { ok: false }>;
    assert.equal(failed.status, 503);
    assert.equal(failed.reason, "billing_unavailable");
  } finally {
    globalThis.fetch = original;
    if (previousEnabled === undefined) delete process.env.NEST_BILLING_ENABLED;
    else process.env.NEST_BILLING_ENABLED = previousEnabled;
    if (previousBase === undefined) delete process.env.NEST_BILLING_BASE_URL;
    else process.env.NEST_BILLING_BASE_URL = previousBase;
  }
});

test("nest 返回固定线格式 reason → preflight 结果保留 reason 与 Retry-After", async () => {
  const original = globalThis.fetch;
  const previousEnabled = process.env.NEST_BILLING_ENABLED;
  const previousBase = process.env.NEST_BILLING_BASE_URL;
  process.env.NEST_BILLING_ENABLED = "1";
  process.env.NEST_BILLING_BASE_URL = "http://nest.local";
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          reason: "insufficient_balance",
          message: "余额不足，请先充值",
        }),
        {
          status: 402,
          headers: { "content-type": "application/json", "retry-after": "0" },
        }
      )) as unknown as typeof globalThis.fetch;
    const result = await nestPreflight({ key: "sk-x", model: "m", stream: false });
    assert.equal(result.ok, false);
    const failed = result as Extract<NestPreflightResult, { ok: false }>;
    assert.equal(failed.reason, "insufficient_balance");
    assert.equal(failed.status, 402);
  } finally {
    globalThis.fetch = original;
    if (previousEnabled === undefined) delete process.env.NEST_BILLING_ENABLED;
    else process.env.NEST_BILLING_ENABLED = previousEnabled;
    if (previousBase === undefined) delete process.env.NEST_BILLING_BASE_URL;
    else process.env.NEST_BILLING_BASE_URL = previousBase;
  }
});

test("嵌套响应头：T2.2 透传 x-real-ip 给 nest", async () => {
  const original = globalThis.fetch;
  const previousEnabled = process.env.NEST_BILLING_ENABLED;
  const previousBase = process.env.NEST_BILLING_BASE_URL;
  const seen: Record<string, string> = {};
  process.env.NEST_BILLING_ENABLED = "1";
  process.env.NEST_BILLING_BASE_URL = "http://nest.local";
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen["x-real-ip"] = headers.get("x-real-ip") ?? "";
      return new Response(JSON.stringify({ ticket: "t-ip" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const ok = await nestPreflight({
      key: "sk-x",
      model: "m",
      stream: false,
      clientIp: "203.0.113.9",
    });
    assert.equal(ok.ok, true);
    assert.equal(seen["x-real-ip"], "203.0.113.9");
  } finally {
    globalThis.fetch = original;
    if (previousEnabled === undefined) delete process.env.NEST_BILLING_ENABLED;
    else process.env.NEST_BILLING_ENABLED = previousEnabled;
    if (previousBase === undefined) delete process.env.NEST_BILLING_BASE_URL;
    else process.env.NEST_BILLING_BASE_URL = previousBase;
  }
});

afterEach(() => {
  delete process.env.NEST_BILLING_ENABLED;
});
