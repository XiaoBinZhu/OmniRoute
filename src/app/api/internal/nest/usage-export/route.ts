/**
 * 内部只读导出端点（T5.1）：`GET /api/internal/nest/usage-export`
 *
 * nest 的 `CostBackfillService` 每 10 分钟拉取一次，用 `correlationId` 回填
 * `ai_gateway_log.cost_amount/profit_amount`。只返回元数据与 token/cost，
 * **不返回任何请求/响应正文**。
 *
 * 鉴权：`x-edge-secret` = `NEST_EDGE_SECRET`（与 settle 共用，timing-safe）。
 * 网络面：该路径仅在内部 server（10.0.0.1:8080）与 nginx 内部 LB 上可达。
 *
 * @module app/api/internal/nest/usage-export
 */

import { timingSafeEqual } from "node:crypto";

import { listCallLogsForNestExport } from "@/lib/usage/callLogs";
import { nestBillingConfig } from "@/lib/nestBilling/config";

function safeEqual(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  const { edgeSecret } = nestBillingConfig();
  if (!safeEqual(request.headers.get("x-edge-secret"), edgeSecret)) {
    return new Response(JSON.stringify({ ok: false, reason: "invalid_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const since =
    String(url.searchParams.get("since") ?? "").trim() ||
    new Date(Date.now() - 30 * 60_000).toISOString();
  const cursor = String(url.searchParams.get("cursor") ?? "").trim() || null;
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? 500) || 500));

  try {
    const rows = listCallLogsForNestExport(since, cursor, limit);
    // 复合游标 `<timestamp>|<id>`：id 是 UUID，单列排序与时间无关，跨页会漏行
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    return new Response(
      JSON.stringify({
        ok: true,
        rows,
        nextCursor: last ? `${last.timestamp}|${last.id}` : null,
        since,
      }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, reason: "internal_error", message: (error as Error)?.message }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
