/**
 * Nest billing flags (blueprint D2).
 *
 * `NEST_BILLING_ENABLED` defaults to 0: with it unset the gateway behaves
 * exactly as before (OmniRoute-only auth and local usage accounting).
 */
export function isNestBillingEnabled(): boolean {
  const raw = String(process.env.NEST_BILLING_ENABLED ?? "0")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function nestBillingConfig(): {
  baseUrl: string;
  edgeSecret: string;
  timeoutMs: number;
} {
  return {
    baseUrl: String(process.env.NEST_BILLING_BASE_URL ?? "http://10.0.0.2:7001").replace(
      /\/+$/,
      ""
    ),
    edgeSecret: String(process.env.NEST_EDGE_SECRET ?? ""),
    timeoutMs: Math.max(500, Number(process.env.NEST_BILLING_TIMEOUT_MS ?? 5000) || 5000),
  };
}

/** Chat completions is the only route that participates in nest billing. */
export function isNestBillingChatPath(url: string): boolean {
  try {
    return new URL(url, "http://localhost").pathname === "/api/v1/chat/completions";
  } catch {
    return false;
  }
}

/** Nest tokens are `sk-`, same prefix as OmniRoute keys; OmniRoute keys win when valid. */
export function isNestBillingKeyCandidate(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith("sk-");
}
