import { isIP } from "node:net";

/**
 * T07: Extract the real client IP from X-Forwarded-For header.
 * Skips invalid entries like "unknown" or empty strings.
 * Falls back to remoteAddress if no valid IP found.
 * Ref: sub2api PR #1135
 *
 * @param xForwardedFor - Value of the X-Forwarded-For header (may be CSV)
 * @param remoteAddress - Fallback from the raw socket (req.socket.remoteAddress)
 * @returns The first valid IP address found, or "unknown"
 */
export function extractClientIp(
  xForwardedFor: string | null | undefined,
  remoteAddress: string | undefined
): string {
  if (xForwardedFor) {
    const entries = xForwardedFor.split(",");
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed && isIP(trimmed) !== 0) {
        return trimmed; // First valid IP wins
      }
    }
  }
  return remoteAddress?.trim() ?? "unknown";
}

/**
 * Strip an IPv4-mapped IPv6 prefix ("::ffff:127.0.0.1" -> "127.0.0.1") so the
 * loopback check below catches both representations Node may report.
 */
function normalizePeer(addr: string | undefined): string {
  const trimmed = (addr ?? "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

/**
 * Whether the TCP peer is a loopback address (i.e. the request reached us via
 * a local reverse proxy such as nginx). Only then is it safe to trust the
 * forwarding headers — from a direct public socket those headers are
 * attacker-controlled and must be ignored, otherwise per-IP brute-force
 * buckets (login lockout, etc.) become spoofable / shareable.
 *
 * Ported from decolua/9router#1893.
 */
function isLoopbackPeer(addr: string | undefined): boolean {
  const ip = normalizePeer(addr);
  if (!ip) return false;
  if (ip === "::1") return true;
  return ip.startsWith("127.");
}

/**
 * Trusted reverse-proxy CIDRs, from `OMNIROUTE_TRUSTED_PROXY_CIDRS`
 * (comma-separated IPv4 CIDRs, e.g. `172.19.0.0/16,10.1.0.5/32`).
 *
 * Empty by default → only loopback peers are trusted, exactly as before, so
 * enabling this never loosens an existing deployment by accident.
 *
 * Why it exists: a containerised deployment often reaches the app through a
 * reverse proxy that runs in another network namespace, so the TCP peer is the
 * Docker bridge gateway (`172.19.0.1`) rather than `127.0.0.1`. That peer is
 * not loopback, so the forwarding headers were ignored and EVERY public client
 * collapsed onto the same address — which turned the per-IP login lockout into
 * a single global bucket: five failed logins from anyone locked the whole
 * dashboard for everyone, and a trivial denial of service. Listing the proxy
 * address here restores per-client buckets.
 */
function trustedProxyCidrs(): string[] {
  return (process.env.OMNIROUTE_TRUSTED_PROXY_CIDRS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** IPv4 dotted-quad → 32-bit unsigned integer; null when not a valid IPv4. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * Whether `ip` falls inside `cidr`. Invalid CIDRs return false (fail-closed:
 * a typo must never widen which peers are trusted). A bare IP is treated as /32.
 */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  // Number("") === 0 would silently turn a trailing-slash typo ("10.0.0.0/")
  // into /0 — i.e. "trust every peer". Treat an empty prefix as invalid.
  if (bitsRaw !== undefined && bitsRaw.trim() === "") return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const addr = ipv4ToInt(ip);
  const network = ipv4ToInt(base ?? "");
  if (addr === null || network === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (network & mask);
}

/**
 * Whether the TCP peer is a reverse proxy we may trust for forwarding headers:
 * loopback, or an address listed in `OMNIROUTE_TRUSTED_PROXY_CIDRS`.
 *
 * Only then is it safe to trust `X-Forwarded-For` — from a direct public socket
 * those headers are attacker-controlled, and believing them would let a caller
 * pick its own rate-limit bucket.
 */
function isTrustedProxy(addr: string | undefined): boolean {
  const ip = normalizePeer(addr);
  if (!ip) return false;
  if (isLoopbackPeer(ip)) return true;
  // Only IPv4 CIDRs are supported; an IPv6 peer (other than ::1, handled above)
  // is not treated as a trusted proxy.
  if (isIP(ip) !== 4) return false;
  return trustedProxyCidrs().some((cidr) => ipv4InCidr(ip, cidr));
}

export type IpScope = "loopback" | "private" | "public" | "unknown";

/**
 * Whether an IPv4/IPv6 address falls inside a private (RFC 1918 / RFC 4193) or
 * link-local range. Uses bounded string-prefix checks (no variable-length regex)
 * to stay ReDoS-safe. Callers must pass an already-normalized, validated IP.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4 private / link-local ranges.
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true; // link-local (APIPA)
  if (ip.startsWith("172.")) {
    // 172.16.0.0 – 172.31.255.255 (the /12 block).
    const secondOctet = Number.parseInt(ip.split(".")[1] ?? "", 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  // IPv6 unique-local (fc00::/7 → fc/fd) and link-local (fe80::/10).
  const lower = ip.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

/**
 * Classify an address by network scope: `loopback` (the host itself),
 * `private` (LAN / RFC 1918 / ULA / link-local), `public` (routable), or
 * `unknown` (empty / non-IP string like "unknown").
 *
 * Used to distinguish audit events — notably failed dashboard logins
 * (`auth.login.failed`) — that originate from the box itself or the local
 * network from genuinely external ones, so an internal mistyped password or a
 * browser-autofill replay does not read as an external intrusion attempt.
 *
 * Ref: issue #8336.
 */
export function classifyIpScope(addr: string | null | undefined): IpScope {
  const ip = normalizePeer(addr ?? undefined);
  if (!ip) return "unknown";
  if (isLoopbackPeer(ip)) return "loopback";
  // isIP returns 0 for non-IP strings ("unknown", hostnames); only classify
  // real addresses beyond loopback so hostnames never resolve to private.
  if (isIP(ip) === 0) return "unknown";
  if (isPrivateIp(ip)) return "private";
  return "public";
}

/**
 * Extract client IP from a Request or NextRequest object.
 *
 * Behind a local reverse proxy (TCP peer is loopback) we trust the standard
 * forwarding headers in priority order: CF-Connecting-IP > X-Forwarded-For >
 * X-Real-IP. Directly from a public socket those headers are spoofable, so we
 * key by the unspoofable TCP peer address instead. When no peer is known
 * (edge runtime / fetch path with no socket) we fall back to the headers so
 * we don't regress to "unknown" for every request in that path.
 */
export function getClientIpFromRequest(req: {
  headers?: Headers | { get?: (n: string) => string | null };
  socket?: { remoteAddress?: string };
  ip?: string;
}): string {
  // Helper to get header value from either Headers object or plain object
  const getHeader = (name: string): string | null => {
    if (!req.headers) return null;
    if (typeof (req.headers as Headers).get === "function") {
      return (req.headers as Headers).get(name);
    }
    return null;
  };

  const remoteAddress = req.ip ?? req.socket?.remoteAddress;
  const hasPeer = Boolean(normalizePeer(remoteAddress));
  // Loopback proxies (nginx on the host) and explicitly configured proxies
  // (OMNIROUTE_TRUSTED_PROXY_CIDRS — e.g. a Docker bridge gateway) are trusted;
  // a direct public peer is not.
  const trustForwardingHeaders = !hasPeer || isTrustedProxy(remoteAddress);

  if (trustForwardingHeaders) {
    const cfIp = getHeader("cf-connecting-ip");
    if (cfIp && isIP(cfIp.trim()) !== 0) return cfIp.trim();

    const xff = getHeader("x-forwarded-for");
    const realIp = getHeader("x-real-ip");
    return extractClientIp(xff ?? realIp, remoteAddress);
  }

  // Direct public peer — forwarding headers are attacker-controlled, ignore.
  return normalizePeer(remoteAddress);
}
