import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { ensureDbInitialized, getDbInstance } from "../../src/lib/db/core.ts";
import {
  enqueueOutbox,
  getNestBillingOutboxStatus,
  replayNestBillingOutbox,
} from "../../src/lib/nestBilling/client.ts";
import { isOutboxWorkerEnabled } from "../../src/lib/nestBilling/outboxWorker.ts";

/**
 * T2.1：outbox 回放分类（2xx sent / 401 暂停 / 400·402 dead / 409·5xx 退避重试）。
 */

type FetchPlan = Array<{ status: number } | { throw: true }>;

let plan: FetchPlan = [];
let originalFetch: typeof globalThis.fetch;

function installFetch(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const next = plan.shift();
    if (!next) throw new Error("unexpected fetch");
    if ("throw" in next) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ ok: next.status < 300 }), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

async function resetOutbox(): Promise<void> {
  await ensureDbInitialized();
  const db = getDbInstance();
  db.prepare(`DELETE FROM nest_billing_outbox`).run();
}

beforeEach(async () => {
  process.env.NEST_BILLING_ENABLED = "true";
  process.env.NEST_BILLING_BASE_URL = "http://nest.local";
  process.env.NEST_EDGE_SECRET = "edge-secret";
  process.env.NEST_BILLING_TIMEOUT_MS = "2000";
  await resetOutbox();
  installFetch();
  plan = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NEST_BILLING_ENABLED;
  delete process.env.NEST_BILLING_BASE_URL;
  delete process.env.NEST_EDGE_SECRET;
  delete process.env.NEST_BILLING_TIMEOUT_MS;
  delete process.env.NEST_BILLING_OUTBOX_WORKER;
});

function seed(rows = 1): void {
  for (let index = 0; index < rows; index += 1) {
    enqueueOutbox(`ticket-${index}`, JSON.stringify({ ticket: `ticket-${index}` }), "boom", 500);
  }
}

/** 把 next_attempt_at 提前，模拟"已到重试时间" */
function makeDue(): void {
  getDbInstance()
    .prepare(`UPDATE nest_billing_outbox SET next_attempt_at = ?`)
    .run(new Date(Date.now() - 1000).toISOString());
}

test("2xx → sent", async () => {
  seed(1);
  makeDue();
  plan = [{ status: 200 }];
  const outcome = await replayNestBillingOutbox(10);
  assert.equal(outcome.sent, 1);
  assert.equal(getNestBillingOutboxStatus().pending, 0);
});

test("5xx → 退避重试（仍未到 next_attempt_at 时不重复捞取）", async () => {
  seed(1);
  makeDue();
  plan = [{ status: 500 }];
  const first = await replayNestBillingOutbox(10);
  assert.equal(first.retried, 1);
  assert.equal(getNestBillingOutboxStatus().pending, 1);
  // 退避后立刻再跑不会再请求（未到期）
  plan = [{ status: 200 }];
  const second = await replayNestBillingOutbox(10);
  assert.equal(second.sent, 0);
  assert.equal(second.retried, 0);
});

test("网络异常 → 重试", async () => {
  seed(1);
  makeDue();
  plan = [{ throw: true }];
  const outcome = await replayNestBillingOutbox(10);
  assert.equal(outcome.retried, 1);
  assert.equal(getNestBillingOutboxStatus().pending, 1);
});

test("400 / 402 → dead（不再重试）", async () => {
  seed(2);
  makeDue();
  plan = [{ status: 400 }, { status: 402 }];
  const outcome = await replayNestBillingOutbox(10);
  assert.equal(outcome.dead, 2);
  const status = getNestBillingOutboxStatus();
  assert.equal(status.pending, 0);
  assert.equal(status.dead, 2);
});

test("401 → 暂停整个 worker（不消耗 attempts，行保持 pending）", async () => {
  seed(1);
  makeDue();
  plan = [{ status: 401 }];
  const outcome = await replayNestBillingOutbox(10);
  assert.equal(outcome.unauthorized, true);
  assert.equal(outcome.sent, 0);
  const status = getNestBillingOutboxStatus();
  assert.equal(status.pending, 1);
  assert.equal(status.dead, 0);
});

test("worker 开关：NEST_BILLING_OUTBOX_WORKER=0 关闭", () => {
  assert.equal(isOutboxWorkerEnabled({}), true);
  assert.equal(isOutboxWorkerEnabled({ NEST_BILLING_OUTBOX_WORKER: "0" }), false);
  assert.equal(isOutboxWorkerEnabled({ NEST_BILLING_OUTBOX_WORKER: "false" }), false);
  assert.equal(isOutboxWorkerEnabled({ NEST_BILLING_OUTBOX_WORKER: "1" }), true);
});
