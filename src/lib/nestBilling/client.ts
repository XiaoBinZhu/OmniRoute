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
  /** T2.2：客户端真实 IP（宿主 nginx 注入的 `x-real-ip`），供 nest 做令牌 IP 白/黑名单 */
  clientIp?: string | null;
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
    /** T2.3：true = promptTokens 已包含缓存，nest 计价需先扣除 cacheRead */
    promptIncludesCache?: boolean;
  };
  durationMs: number;
  aborted?: boolean;
  error?: string | null;
  upstreamProvider?: string | null;
  upstreamModel?: string | null;
  upstreamCost?: number | null;
  omnirouteRequestId?: string | null;
  traceId?: string | null;
  /** T2.1：预检返回的幂等键（ticket 过期后 nest 用它在会话表定位预扣） */
  billingRequestId?: string | null;
  /** T2.3：用量来源（upstream_usage / estimated / estimated_abort） */
  usageProvenance?: string | null;
  /** T3.4：规范化端点（/v1/chat/completions 等） */
  endpoint?: string | null;
  /** T2.1：请求模型（迟到结算时 ticket 已过期，nest 需要它重新计价） */
  model?: string | null;
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
  // T2.1/N8：幂等键必须能回传——客户端没带时用本地生成的 UUID，
  // 并随 settle 的 billingRequestId 传回，否则 ticket 过期后无法定位预扣会话。
  const sentIdempotencyKey = input.idempotencyKey?.trim() || randomUUID();
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
        "x-idempotency-key": sentIdempotencyKey,
        // T2.2：透传客户端 IP（不传时 nest 用 socket 对端，白名单令牌会被误判）
        ...(input.clientIp ? { "x-real-ip": input.clientIp } : {}),
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
    return {
      ok: true,
      ticket,
      userId: payload?.userId,
      tokenId: payload?.tokenId,
      // T2.1/N8：nest 预检返回的幂等键（＝写入 billing_session 的 requestId）；
      // 缺失时（旧版 nest）回退到本地发送的 x-idempotency-key。
      billingRequestId:
        typeof payload?.billingRequestId === "string" && payload.billingRequestId
          ? payload.billingRequestId
          : sentIdempotencyKey,
    };
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
    // T2.1/T2.3/T3.4：迟到结算定位键、用量来源、端点、模型
    billingRequestId: input.billingRequestId ?? undefined,
    usageProvenance: input.usageProvenance ?? undefined,
    endpoint: input.endpoint ?? undefined,
    model: input.model ?? undefined,
  });

  let lastError = "";
  let lastStatus: number | null = null;
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
      lastStatus = response.status;
      if (response.status < 500) break;
    } catch (error) {
      lastError = (error as Error)?.message ?? String(error);
      lastStatus = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * Math.pow(3, attempt)));
  }

  enqueueOutbox(input.ticket, body, lastError, lastStatus);
  return { ok: false, error: lastError };
}

/** outbox 重试上限：超过则置 dead（需人工介入，不再无休止重试） */
export const OUTBOX_MAX_ATTEMPTS = 50;
/** 首次退避 */
const OUTBOX_BASE_DELAY_MS = 30_000;
/** 最大退避 */
const OUTBOX_MAX_DELAY_MS = 60 * 60 * 1000;

function outboxBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(OUTBOX_MAX_DELAY_MS, OUTBOX_BASE_DELAY_MS * Math.pow(2, exponent));
}

/** Durable replay queue (SQLite, migration 215/216). Failure here must never break the response. */
export function enqueueOutbox(
  ticket: string,
  payload: string,
  lastError: string,
  lastStatus?: number | null
): void {
  try {
    const db = getDbInstance();
    const now = Date.now();
    db.prepare(
      `INSERT INTO nest_billing_outbox
         (id, created_at, ticket, payload, attempts, last_error, status, next_attempt_at, last_status)
       VALUES (@id, @createdAt, @ticket, @payload, 0, @lastError, 'pending', @nextAttemptAt, @lastStatus)`
    ).run({
      id: randomUUID(),
      createdAt: new Date(now).toISOString(),
      ticket,
      payload,
      lastError: String(lastError ?? "").slice(0, 1000),
      nextAttemptAt: new Date(now + OUTBOX_BASE_DELAY_MS).toISOString(),
      lastStatus: lastStatus ?? null,
    });
  } catch (error) {
    console.error("[nestBilling] outbox insert failed:", (error as Error)?.message ?? error);
  }
}

export interface OutboxReplayOutcome {
  sent: number;
  retried: number;
  dead: number;
  /** 401（共享密钥不一致）：配置错误，worker 应暂停并告警 */
  unauthorized: boolean;
}

/**
 * 回放到期行（T2.1）。分类语义：
 * - 2xx → sent
 * - 401 → 暂停整个 worker（配置错误，重试无意义）
 * - 400/402 → dead（数据/额度问题，重试只会刷日志）
 * - 409/5xx/网络 → 指数退避重试；attempts 达上限置 dead
 */
export async function replayNestBillingOutbox(limit = 20): Promise<OutboxReplayOutcome> {
  const outcome: OutboxReplayOutcome = { sent: 0, retried: 0, dead: 0, unauthorized: false };
  if (!isNestBillingEnabled()) return outcome;
  const { baseUrl, edgeSecret, timeoutMs } = nestBillingConfig();
  if (!edgeSecret) return outcome;
  const db = getDbInstance();
  const nowIso = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT id, payload, attempts FROM nest_billing_outbox
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(nowIso, limit) as Array<{ id: string; payload: string; attempts: number }>;

  for (const row of rows) {
    let status = 0;
    let errorText = "";
    try {
      const response = await fetch(`${baseUrl}/ai/edge/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-edge-secret": edgeSecret },
        body: row.payload,
        signal: timeoutSignal(timeoutMs),
      });
      status = response.status;
    } catch (error) {
      status = 0;
      errorText = String((error as Error)?.message ?? error);
    }

    const attempts = row.attempts + 1;
    if (status >= 200 && status < 300) {
      db.prepare(
        `UPDATE nest_billing_outbox SET status = 'sent', attempts = ?, last_status = ? WHERE id = ?`
      ).run(attempts, status, row.id);
      outcome.sent += 1;
      continue;
    }

    if (status === 401) {
      // 不消耗 attempts：配置修好后应能立即回放
      db.prepare(`UPDATE nest_billing_outbox SET last_status = ?, last_error = ? WHERE id = ?`).run(
        status,
        "401 invalid edge secret",
        row.id
      );
      outcome.unauthorized = true;
      break;
    }

    if (status === 400 || status === 402) {
      db.prepare(
        `UPDATE nest_billing_outbox SET status = 'dead', attempts = ?, last_status = ?, last_error = ? WHERE id = ?`
      ).run(attempts, status, `HTTP ${status} (dead)`, row.id);
      outcome.dead += 1;
      continue;
    }

    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE nest_billing_outbox SET status = 'dead', attempts = ?, last_status = ?, last_error = ? WHERE id = ?`
      ).run(
        attempts,
        status || null,
        `max attempts reached (${errorText || `HTTP ${status}`})`,
        row.id
      );
      outcome.dead += 1;
      continue;
    }

    db.prepare(
      `UPDATE nest_billing_outbox
         SET attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?
       WHERE id = ?`
    ).run(
      attempts,
      status || null,
      (errorText || `HTTP ${status}`).slice(0, 1000),
      new Date(Date.now() + outboxBackoffMs(attempts)).toISOString(),
      row.id
    );
    outcome.retried += 1;
  }

  return outcome;
}

/** 只读状态（供 `/api/internal/nest/outbox-status` 与对账页） */
export function getNestBillingOutboxStatus(): {
  pending: number;
  dead: number;
  sent: number;
  oldestPendingAt: string | null;
} {
  try {
    const db = getDbInstance();
    const rows = db
      .prepare(`SELECT status, COUNT(*) AS c FROM nest_billing_outbox GROUP BY status`)
      .all() as Array<{ status: string; c: number }>;
    const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.c)]));
    const oldest = db
      .prepare(`SELECT MIN(created_at) AS oldest FROM nest_billing_outbox WHERE status = 'pending'`)
      .get() as { oldest?: string | null } | undefined;
    return {
      pending: byStatus.pending ?? 0,
      dead: byStatus.dead ?? 0,
      sent: byStatus.sent ?? 0,
      oldestPendingAt: oldest?.oldest ?? null,
    };
  } catch {
    return { pending: 0, dead: 0, sent: 0, oldestPendingAt: null };
  }
}
