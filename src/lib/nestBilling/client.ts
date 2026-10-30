import { createHash, randomUUID } from "node:crypto";

import { getDbInstance } from "../db/core";
import { nestBillingConfig, isNestBillingEnabled } from "./config";

export interface NestPreflightInput {
  key: string;
  model: string;
  stream: boolean;
  maxTokens?: number;
  promptTokens?: number;
  bodyDigest?: string;
  idempotencyKey?: string | null;
  /** F16：预扣阶段 cache 四维（可选） */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  cacheWrite1hTokens?: number;
  promptIncludesCache?: boolean;
}

export type NestPreflightResult =
  | { ok: true; ticket: string; userId?: number; tokenId?: number; billingRequestId?: string }
  | {
      ok: false;
      status: number;
      message: string;
      code?: string;
      /** T1.4 契约：nest 的稳定业务码（insufficient_balance / invalid_token …） */
      reason?: string;
      /** 429 限流类：透过 nest 的 Retry-After */
      retryAfterSeconds?: number;
    };

export interface NestSettleInput {
  ticket: string;
  status: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    cacheWrite1hTokens?: number;
  };
  durationMs: number;
  aborted?: boolean;
  error?: string | null;
  upstreamProvider?: string | null;
  upstreamModel?: string | null;
  upstreamCost?: number | null;
  omnirouteRequestId?: string | null;
  traceId?: string | null;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Do not keep the process alive for the timer.
  timer.unref?.();
  return controller.signal;
}

async function readEnvelope(response: Response): Promise<any> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Preflight: POST /ai/edge/check. Never throws — callers translate the result. */
export async function nestPreflight(input: NestPreflightInput): Promise<NestPreflightResult> {
  if (!isNestBillingEnabled()) {
    return {
      ok: false,
      status: 503,
      message: "Nest billing is disabled",
      code: "billing_unavailable",
      reason: "billing_unavailable",
    };
  }
  const { baseUrl, timeoutMs } = nestBillingConfig();
  const bodyDigest =
    input.bodyDigest ??
    createHash("sha256")
      .update(
        JSON.stringify({
          model: input.model,
          stream: input.stream,
          maxTokens: input.maxTokens ?? 4096,
        })
      )
      .digest("hex");
  try {
    const response = await fetch(`${baseUrl}/ai/edge/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.key}`,
        "x-idempotency-key": input.idempotencyKey ?? randomUUID(),
      },
      body: JSON.stringify({
        model: input.model,
        stream: input.stream,
        // F15：未声明 max_tokens 时按 4096 估算，避免预扣被低估
        maxTokens: input.maxTokens ?? 4096,
        promptTokens: input.promptTokens ?? 0,
        bodyDigest,
        cacheWriteTokens: input.cacheWriteTokens ?? 0,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        cacheWrite1hTokens: input.cacheWrite1hTokens ?? 0,
        promptIncludesCache: input.promptIncludesCache === true,
      }),
      signal: timeoutSignal(timeoutMs),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok) {
      // T1.4：优先读固定线格式的 reason；旧版 nest 只有 code（字符串时当 reason 用）
      const rawReason = envelope?.reason ?? envelope?.code;
      const reason =
        typeof rawReason === "string" && rawReason.trim() ? rawReason.trim() : undefined;
      const rawMessage = typeof envelope?.message === "string" ? envelope.message.trim() : "";
      // 旧格式会把业务码写成 `insufficient_balance: xxx` 前缀，取前缀兼容
      const prefixReason = /^([a-z_]+):/.exec(rawMessage)?.[1];
      const retryAfterHeader = Number(response.headers.get("retry-after") ?? "");
      return {
        ok: false,
        status: response.status,
        message: rawMessage || `nest preflight failed (${response.status})`,
        code: reason ?? (envelope?.code ? String(envelope.code) : undefined),
        reason: reason ?? prefixReason,
        retryAfterSeconds:
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined,
      };
    }
    const payload = envelope?.data ?? envelope;
    const ticket = payload?.ticket;
    if (typeof ticket !== "string" || !ticket) {
      return {
        ok: false,
        status: 503,
        message: "nest preflight returned no ticket",
        code: "billing_unavailable",
        reason: "billing_unavailable",
      };
    }
    return { ok: true, ticket, userId: payload?.userId, tokenId: payload?.tokenId };
  } catch (error) {
    // N15：nest 不可达/超时 → 503 billing_unavailable（客户端可重试），不是 502
    return {
      ok: false,
      status: 503,
      message: `nest preflight unavailable: ${(error as Error)?.message ?? error}`,
      code: "billing_unavailable",
      reason: "billing_unavailable",
    };
  }
}

/** Postflight: POST /ai/edge/settle with bounded retries. */
export async function nestSettle(input: NestSettleInput): Promise<{ ok: boolean; error?: string }> {
  if (!isNestBillingEnabled()) return { ok: true };
  const { baseUrl, edgeSecret, timeoutMs } = nestBillingConfig();
  if (!edgeSecret) {
    return { ok: false, error: "NEST_EDGE_SECRET is not configured" };
  }
  const body = JSON.stringify({
    ticket: input.ticket,
    status: input.status,
    usage: input.usage,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    aborted: input.aborted === true,
    error: input.error ?? undefined,
    upstreamProvider: input.upstreamProvider ?? undefined,
    upstreamModel: input.upstreamModel ?? undefined,
    upstreamCost: input.upstreamCost ?? undefined,
    omnirouteRequestId: input.omnirouteRequestId ?? undefined,
    traceId: input.traceId ?? undefined,
  });

  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/ai/edge/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-edge-secret": edgeSecret,
        },
        body,
        signal: timeoutSignal(timeoutMs),
      });
      if (response.ok) return { ok: true };
      lastError = `settle HTTP ${response.status}`;
      if (response.status < 500) break;
    } catch (error) {
      lastError = (error as Error)?.message ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * Math.pow(3, attempt)));
  }

  enqueueOutbox(input.ticket, body, lastError);
  return { ok: false, error: lastError };
}

/** Durable replay queue (SQLite, migration 215). Failure here must never break the response. */
export function enqueueOutbox(ticket: string, payload: string, lastError: string): void {
  try {
    const db = getDbInstance();
    db.prepare(
      `INSERT INTO nest_billing_outbox (id, created_at, ticket, payload, attempts, last_error, status)
       VALUES (@id, @createdAt, @ticket, @payload, 0, @lastError, 'pending')`
    ).run({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ticket,
      payload,
      lastError: String(lastError ?? "").slice(0, 1000),
    });
  } catch (error) {
    console.error("[nestBilling] outbox insert failed:", (error as Error)?.message ?? error);
  }
}

/** Best-effort replay used by maintenance jobs/tests; safe to call repeatedly. */
export async function replayNestBillingOutbox(limit = 20): Promise<number> {
  if (!isNestBillingEnabled()) return 0;
  const { baseUrl, edgeSecret, timeoutMs } = nestBillingConfig();
  if (!edgeSecret) return 0;
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT id, payload FROM nest_billing_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
    )
    .all(limit) as Array<{ id: string; payload: string }>;
  let replayed = 0;
  for (const row of rows) {
    try {
      const response = await fetch(`${baseUrl}/ai/edge/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-edge-secret": edgeSecret },
        body: row.payload,
        signal: timeoutSignal(timeoutMs),
      });
      if (response.ok) {
        db.prepare(
          `UPDATE nest_billing_outbox SET status = 'sent', attempts = attempts + 1 WHERE id = ?`
        ).run(row.id);
        replayed += 1;
      } else {
        db.prepare(`UPDATE nest_billing_outbox SET attempts = attempts + 1 WHERE id = ?`).run(
          row.id
        );
      }
    } catch (error) {
      db.prepare(
        `UPDATE nest_billing_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`
      ).run(String((error as Error)?.message ?? error).slice(0, 1000), row.id);
    }
  }
  return replayed;
}
