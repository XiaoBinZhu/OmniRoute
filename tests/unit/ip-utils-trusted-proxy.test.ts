import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { getClientIpFromRequest } from "../../src/lib/ipUtils";

/**
 * Trusted reverse proxy handling for client IP resolution.
 *
 * Regression guard for a live incident: the app ran behind a proxy in another
 * network namespace, so the TCP peer was the Docker bridge gateway
 * (172.19.0.1) instead of 127.0.0.1. Because that peer is not loopback, the
 * forwarding headers were ignored and every public client shared one address —
 * so `loginGuard`'s per-IP lockout became a global bucket: five failed logins
 * from anyone locked the dashboard for everyone for 15 minutes.
 *
 * The fix keeps the default strict (loopback only) and adds an explicit opt-in
 * via OMNIROUTE_TRUSTED_PROXY_CIDRS.
 */

const ENV_KEY = "OMNIROUTE_TRUSTED_PROXY_CIDRS";

function req(peer: string | undefined, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    socket: peer ? { remoteAddress: peer } : undefined,
  };
}

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("getClientIpFromRequest — trusted proxies", () => {
  it("trusts X-Forwarded-For from a loopback proxy by default", () => {
    const ip = getClientIpFromRequest(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(ip, "203.0.113.9");
  });

  it("trusts cf-connecting-ip ahead of x-forwarded-for from loopback", () => {
    const ip = getClientIpFromRequest(
      req("::ffff:127.0.0.1", {
        "cf-connecting-ip": "198.51.100.4",
        "x-forwarded-for": "203.0.113.9",
      })
    );
    assert.equal(ip, "198.51.100.4");
  });

  it("ignores forwarding headers from a public peer (they are spoofable)", () => {
    const ip = getClientIpFromRequest(req("8.8.8.8", { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(ip, "8.8.8.8");
  });

  it("with no configured proxies, a Docker bridge peer still collapses to its own address", () => {
    // This is the pre-fix behaviour, kept as the default so enabling the
    // feature is an explicit operator decision.
    const ip = getClientIpFromRequest(req("172.19.0.1", { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(ip, "172.19.0.1");
  });

  it("trusts forwarding headers from a configured proxy CIDR", () => {
    process.env[ENV_KEY] = "172.19.0.0/16";
    const ip = getClientIpFromRequest(req("172.19.0.1", { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(ip, "203.0.113.9");
  });

  it("accepts a bare IP entry as a /32", () => {
    process.env[ENV_KEY] = "10.1.2.3";
    assert.equal(
      getClientIpFromRequest(req("10.1.2.3", { "x-forwarded-for": "203.0.113.9" })),
      "203.0.113.9"
    );
    // neighbouring address is NOT covered
    assert.equal(
      getClientIpFromRequest(req("10.1.2.4", { "x-forwarded-for": "203.0.113.9" })),
      "10.1.2.4"
    );
  });

  it("parses a list with spaces and ignores empty entries", () => {
    process.env[ENV_KEY] = " 172.19.0.0/16 , ,10.0.0.0/8 ";
    assert.equal(
      getClientIpFromRequest(req("172.19.0.1", { "x-forwarded-for": "203.0.113.9" })),
      "203.0.113.9"
    );
    assert.equal(
      getClientIpFromRequest(req("10.5.5.5", { "x-forwarded-for": "203.0.113.9" })),
      "203.0.113.9"
    );
  });

  it("fails closed on a malformed CIDR (a typo must not widen trust)", () => {
    // Trailing slash would be Number("") === 0 → /0 → trust everything if we
    // naively parsed it, so it must be rejected outright.
    process.env[ENV_KEY] = "172.19.0.1/99,not-a-cidr,172.19.0.0/";
    const ip = getClientIpFromRequest(req("172.19.0.1", { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(ip, "172.19.0.1");
  });

  it("does not trust an IPv6 peer that is not loopback", () => {
    process.env[ENV_KEY] = "172.19.0.0/16";
    const ip = getClientIpFromRequest(req("2001:db8::1", { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(ip, "2001:db8::1");
  });

  it("falls back to the peer when the forwarding chain holds no valid IP", () => {
    process.env[ENV_KEY] = "172.19.0.0/16";
    const ip = getClientIpFromRequest(req("172.19.0.1", { "x-forwarded-for": "unknown" }));
    assert.equal(ip, "172.19.0.1");
  });

  it("trusts headers when no socket peer is known (edge/fetch path)", () => {
    const ip = getClientIpFromRequest(req(undefined, { "x-forwarded-for": "203.0.113.9" }));
    assert.equal(ip, "203.0.113.9");
  });
});
