import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEST_BILLED_ENDPOINTS,
  isNestBillingKeyCandidate,
  nestBilledEndpoint,
  nestCredentialCandidates,
  nestVerifyOnlyEndpoint,
  normalizeNestEndpointPath,
} from "../../src/lib/nestBilling/credentials.ts";
import {
  nestPreflightShapeRejection,
  preflightWithCandidates,
} from "../../src/lib/nestBilling/preflight.ts";
import {
  collectNestBillingEnvIssues,
  enforceNestBillingRuntimeEnv,
} from "../../src/lib/nestBilling/startupAssertions.ts";
import { enforceClientApiRouteAuth } from "../../src/shared/utils/clientApiRouteAuth.ts";

/**
 * T1.1 凭据收口回归：
 *  - `sk-` 令牌 / 系统 JWT 交给 nest；`sk-ant-*`（Claude Code 自带）不算；
 *  - 候选按 Bearer → x-api-key 排序，最多 2 个（N6）；
 *  - 端点白名单同时识别 `/v1/*` 与 `/api/v1/*`；
 *  - 预检只在 401 时换候选（402 不重试）；
 *  - 有候选但 body 没有 model / 不是对象 → 400（N4）；
 *  - 计费开启时 `NEST_EDGE_SECRET` 为空、自托管变量非空 → 启动断言失败（N9/N4）。
 */

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.c2lnbmF0dXJl";

function chatRequest(
  headers: Record<string, string>,
  url = "http://localhost/api/v1/chat/completions"
) {
  return new Request(url, { method: "POST", headers, body: "{}" });
}

test("凭据判定：sk- 与 JWT 命中，sk-ant-* 与非凭据串不命中", () => {
  assert.equal(isNestBillingKeyCandidate("sk-abc"), true);
  assert.equal(isNestBillingKeyCandidate(JWT), true);
  assert.equal(isNestBillingKeyCandidate("sk-ant-oat01-abc"), false);
  assert.equal(isNestBillingKeyCandidate("or-abc"), false);
  assert.equal(isNestBillingKeyCandidate(""), false);
  assert.equal(isNestBillingKeyCandidate(null), false);
});

test("端点白名单：/v1 与 /api/v1 都命中 chat/messages，其它端点不命中", () => {
  assert.deepEqual(
    [...NEST_BILLED_ENDPOINTS],
    [
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
      "/v1/completions",
      "/v1/embeddings",
      "/v1/rerank",
      "/v1/moderations",
    ]
  );
  assert.equal(nestBilledEndpoint("http://localhost/v1/messages"), "/v1/messages");
  assert.equal(nestBilledEndpoint("http://localhost/api/v1/messages"), "/v1/messages");
  assert.equal(nestBilledEndpoint("http://localhost/api/v1/messages/"), "/v1/messages");
  assert.equal(
    normalizeNestEndpointPath("http://localhost/api/v1/chat/completions/"),
    "/v1/chat/completions"
  );
  assert.equal(nestBilledEndpoint("http://localhost/v1/chat/completions"), "/v1/chat/completions");
  assert.equal(
    nestBilledEndpoint("http://localhost/api/v1/chat/completions"),
    "/v1/chat/completions"
  );
  assert.equal(
    nestBilledEndpoint("http://localhost/api/v1/chat/completions/"),
    "/v1/chat/completions"
  );
  assert.equal(nestBilledEndpoint("http://localhost/v1/embeddings"), "/v1/embeddings");
  assert.equal(nestBilledEndpoint("http://localhost/v1/responses"), "/v1/responses");
  assert.equal(nestBilledEndpoint("http://localhost/v1/completions"), "/v1/completions");
  assert.equal(nestBilledEndpoint("http://localhost/v1/rerank"), "/v1/rerank");
  assert.equal(nestBilledEndpoint("http://localhost/v1/moderations"), "/v1/moderations");
  assert.equal(nestBilledEndpoint("http://localhost/api/v1/models"), null);
  // 非端点路径（含无法构成绝对地址的串）一律不命中
  assert.equal(nestBilledEndpoint("not a url"), null);
  // T3.3：count_tokens 只校验不扣费
  assert.equal(
    nestVerifyOnlyEndpoint("http://localhost/v1/messages/count_tokens"),
    "/v1/messages/count_tokens"
  );
  assert.equal(
    nestVerifyOnlyEndpoint("http://localhost/api/v1/messages/count_tokens"),
    "/v1/messages/count_tokens"
  );
});

test("候选提取：陈旧的 Bearer sk-ant + 有效 x-api-key sk-nest → 只剩 sk-nest（N6）", () => {
  const candidates = nestCredentialCandidates(
    chatRequest({
      authorization: "Bearer sk-ant-oat01-stale",
      "x-api-key": "sk-nest-live",
    })
  );
  assert.deepEqual(candidates, ["sk-nest-live"]);
});

test("候选提取：Bearer 优先，最多 2 个", () => {
  const candidates = nestCredentialCandidates(
    chatRequest({
      authorization: `Bearer ${JWT}`,
      "x-api-key": "sk-second",
      "x-goog-api-key": "sk-third",
    })
  );
  assert.deepEqual(candidates, [JWT, "sk-second"]);
});

test("预检：401 且还有候选时换下一个；402 不换", async () => {
  const original = globalThis.fetch;
  const previousBilling = process.env.NEST_BILLING_ENABLED;
  process.env.NEST_BILLING_ENABLED = "1";
  const seen: string[] = [];
  try {
    let call = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const headers = new Headers(init?.headers);
      seen.push(headers.get("authorization") ?? "");
      const status = call === 1 ? 401 : 200;
      return new Response(
        status === 200 ? JSON.stringify({ ticket: "t-1" }) : JSON.stringify({ message: "bad" }),
        { status, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof globalThis.fetch;

    const ok = await preflightWithCandidates(["sk-first", "sk-second"], {
      model: "m",
      stream: false,
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(seen, ["Bearer sk-first", "Bearer sk-second"]);

    seen.length = 0;
    call = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const headers = new Headers(init?.headers);
      seen.push(headers.get("authorization") ?? "");
      return new Response(
        JSON.stringify({ message: "no balance", reason: "insufficient_balance" }),
        {
          status: 402,
          headers: { "content-type": "application/json" },
        }
      );
    }) as unknown as typeof globalThis.fetch;

    const rejected = await preflightWithCandidates(["sk-first", "sk-second"], {
      model: "m",
      stream: false,
    });
    assert.equal(rejected.ok, false);
    assert.equal((rejected as { status: number }).status, 402);
    assert.deepEqual(seen, ["Bearer sk-first"]);
  } finally {
    globalThis.fetch = original;
    if (previousBilling === undefined) delete process.env.NEST_BILLING_ENABLED;
    else process.env.NEST_BILLING_ENABLED = previousBilling;
  }
});

test("N4：有 nest 候选但 body 不是对象 / 没有 model → 400", () => {
  assert.deepEqual(nestPreflightShapeRejection({ parsedBodyIsRecord: false, model: "m" }), {
    status: 400,
    message: "Request body must be a JSON object",
  });
  assert.deepEqual(nestPreflightShapeRejection({ parsedBodyIsRecord: true, model: "" }), {
    status: 400,
    message: "model is required",
  });
  assert.equal(nestPreflightShapeRejection({ parsedBodyIsRecord: true, model: "m" }), null);
});

test("启动断言：计费开启时 NEST_EDGE_SECRET 为空 / 自托管变量非空 → 报错退出", () => {
  assert.deepEqual(collectNestBillingEnvIssues({}), []);
  assert.deepEqual(
    collectNestBillingEnvIssues({ NEST_BILLING_ENABLED: "1", NEST_EDGE_SECRET: "s" }),
    []
  );
  const missingSecret = collectNestBillingEnvIssues({ NEST_BILLING_ENABLED: "1" });
  assert.equal(missingSecret.length, 1);
  assert.match(missingSecret[0], /NEST_EDGE_SECRET/);

  const selfHosted = collectNestBillingEnvIssues({
    NEST_BILLING_ENABLED: "1",
    NEST_EDGE_SECRET: "s",
    OMNIROUTE_SELF_HOSTED_PROVIDERS: "providers.yaml",
  });
  assert.equal(selfHosted.length, 1);
  assert.match(selfHosted[0], /SELF_HOSTED_PROVIDERS/);

  let exitCode = 0;
  const errors: string[] = [];
  enforceNestBillingRuntimeEnv(
    { NEST_BILLING_ENABLED: "1" },
    { error: (line?: unknown) => errors.push(String(line ?? "")) },
    (code: number) => {
      exitCode = code;
      return undefined as never;
    }
  );
  assert.equal(exitCode, 1);
  assert.ok(errors.some((line) => line.includes("NEST_EDGE_SECRET")));
});

async function withRouterAuthEnv(run: () => Promise<void>): Promise<void> {
  const previousRequire = process.env.REQUIRE_API_KEY;
  const previousBilling = process.env.NEST_BILLING_ENABLED;
  process.env.REQUIRE_API_KEY = "true";
  process.env.NEST_BILLING_ENABLED = "1";
  try {
    await run();
  } finally {
    if (previousRequire === undefined) delete process.env.REQUIRE_API_KEY;
    else process.env.REQUIRE_API_KEY = previousRequire;
    if (previousBilling === undefined) delete process.env.NEST_BILLING_ENABLED;
    else process.env.NEST_BILLING_ENABLED = previousBilling;
  }
}

test("路由级鉴权：无凭据 / 无效串 → 401", async () => {
  await withRouterAuthEnv(async () => {
    const none = await enforceClientApiRouteAuth(chatRequest({}));
    assert.equal(none?.status, 401);
    const invalid = await enforceClientApiRouteAuth(
      chatRequest({ authorization: "Bearer notatoken" })
    );
    assert.equal(invalid?.status, 401);
  });
});

test("路由级鉴权：sk-ant Bearer + 有效 x-api-key 形态 → 放行到预检（N6）", async () => {
  await withRouterAuthEnv(async () => {
    const passed = await enforceClientApiRouteAuth(
      chatRequest({ authorization: "Bearer sk-ant-oat01-stale", "x-api-key": "sk-nest-live" })
    );
    assert.equal(passed, null);
  });
});
