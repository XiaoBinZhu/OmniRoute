import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isNestBillingChatPath,
  isNestBillingEnabled,
  isNestBillingKeyCandidate,
} from "../../src/lib/nestBilling/config.ts";
import { parseUsage } from "../../src/lib/nestBilling/response.ts";

test("nest billing flags default to off and only enable on explicit truthy values", () => {
  const previous = process.env.NEST_BILLING_ENABLED;
  try {
    delete process.env.NEST_BILLING_ENABLED;
    assert.equal(isNestBillingEnabled(), false);
    process.env.NEST_BILLING_ENABLED = "true";
    assert.equal(isNestBillingEnabled(), true);
    process.env.NEST_BILLING_ENABLED = "0";
    assert.equal(isNestBillingEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.NEST_BILLING_ENABLED;
    else process.env.NEST_BILLING_ENABLED = previous;
  }
});

test("only chat completions is deferred to the nest preflight", () => {
  assert.equal(isNestBillingChatPath("http://localhost/api/v1/chat/completions"), true);
  assert.equal(isNestBillingChatPath("http://localhost/api/v1/models"), false);
  assert.equal(isNestBillingKeyCandidate("sk-abc"), true);
  assert.equal(isNestBillingKeyCandidate("or-abc"), false);
});

test("parseUsage reads OpenAI usage and cache details", () => {
  const usage = parseUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 300 },
      cache_creation_input_tokens: 50,
    },
  });
  assert.deepEqual(usage, {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cacheWriteTokens: 50,
    cacheReadTokens: 300,
    cacheWrite1hTokens: 0,
  });
});

test("parseUsage reads Anthropic-style input/output tokens", () => {
  const usage = parseUsage({
    message: {
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 5,
      },
    },
  });
  assert.equal(usage?.promptTokens, 12);
  assert.equal(usage?.completionTokens, 34);
  assert.equal(usage?.totalTokens, 46);
  assert.equal(usage?.cacheReadTokens, 5);
});

test("parseUsage ignores payloads without usage", () => {
  assert.equal(parseUsage({ choices: [{ delta: { content: "hi" } }] }), null);
});
