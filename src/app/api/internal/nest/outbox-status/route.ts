/**
 * 内部只读状态端点（T2.1）：`GET /api/internal/nest/outbox-status`
 *
 * 鉴权：`x-edge-secret` = `NEST_EDGE_SECRET`（与 settle 同一共享密钥，timing-safe）。
 * 网络面：该路径只在内网 server（10.0.0.1:8080）与 nginx 内部 LB 上可用；
 * 公网入口不会暴露（T1.2 已把 /ai/edge/* 收口，本端点仅给 nest 对账页/巡检用）。
 *
 * @module app/api/internal/nest/outbox-status
 */

import { timingSafeEqual } from "node:crypto";

import { getNestBillingOutboxStatus } from "@/lib/nestBilling/client";
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
  const provided = request.headers.get("x-edge-secret");
  if (!safeEqual(provided, edgeSecret)) {
    return new Response(JSON.stringify({ ok: false, reason: "invalid_token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, ...getNestBillingOutboxStatus() }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
