import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TURBOPACK_MIN_BUN,
  bunSupportsTurbopack,
  isTurbopackDisabled,
  resolveDevBundler,
} from "../../scripts/dev/bundler-flags.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The dev runner used to hard-disable Turbopack whenever the process ran under
// Bun (added with the native Bun backend in #11039). Turbopack is supported on
// Bun 1.4+ with Next 16.3 (#11471) and `resolveNextBuildBundlerFlag` never had
// the runtime check, so dev and build disagreed. These pin the replacement
// contract: operator flag first, then a Bun version floor, Node unchanged.

test("resolveDevBundler uses Turbopack on Node", () => {
  assert.equal(resolveDevBundler({ env: {}, bunVersion: undefined }), true);
});

test("resolveDevBundler uses Turbopack on Bun >= 1.4", () => {
  for (const version of ["1.4.0", "1.4.2", "1.5.0", "2.0.0"]) {
    assert.equal(
      resolveDevBundler({ env: {}, bunVersion: version }),
      true,
      `Bun ${version} must use Turbopack`
    );
  }
});

test("resolveDevBundler keeps Webpack on Bun < 1.4", () => {
  for (const version of ["1.3.14", "1.1.20", "1.0.0"]) {
    assert.equal(
      resolveDevBundler({ env: {}, bunVersion: version }),
      false,
      `Bun ${version} must stay on Webpack`
    );
  }
});

test("OMNIROUTE_USE_TURBOPACK=0 forces Webpack on every runtime", () => {
  const env = { OMNIROUTE_USE_TURBOPACK: "0" };
  assert.equal(isTurbopackDisabled(env), true);
  assert.equal(resolveDevBundler({ env, bunVersion: undefined }), false, "Node");
  assert.equal(resolveDevBundler({ env, bunVersion: "1.4.2" }), false, "Bun 1.4.2");
  assert.equal(resolveDevBundler({ env, bunVersion: "1.1.20" }), false, "Bun 1.1.20");
});

test("only the exact string '0' disables Turbopack", () => {
  for (const value of ["1", "false", "no", "", undefined]) {
    const env = { OMNIROUTE_USE_TURBOPACK: value };
    assert.equal(isTurbopackDisabled(env), false, `value ${JSON.stringify(value)}`);
    assert.equal(resolveDevBundler({ env, bunVersion: "1.4.2" }), true, `value ${value}`);
  }
});

test("resolveDevBundler is false outside dev (next start does not bundle again)", () => {
  assert.equal(resolveDevBundler({ env: {}, bunVersion: "1.4.2", dev: false }), false);
  assert.equal(resolveDevBundler({ env: {}, bunVersion: undefined, dev: false }), false);
});

test("bunSupportsTurbopack ignores missing or malformed versions", () => {
  assert.equal(bunSupportsTurbopack(undefined), false);
  assert.equal(bunSupportsTurbopack(""), false);
  assert.equal(bunSupportsTurbopack("canary"), false);
  assert.equal(bunSupportsTurbopack("1"), false, "a bare major cannot clear the floor");
  assert.equal(bunSupportsTurbopack(String(TURBOPACK_MIN_BUN.major)), false);
  assert.equal(bunSupportsTurbopack("1.4"), true);
});

// Source contract: the runtime must not veto Turbopack behind the operator's
// back again. `!isBun` was the exact shape of the original regression.
test("run-next.mjs does not veto Turbopack by runtime", () => {
  const source = readFileSync(path.join(REPO_ROOT, "scripts", "dev", "run-next.mjs"), "utf8");

  assert.doesNotMatch(
    source,
    /!\s*isBun\b/,
    "run-next.mjs must decide the bundler through resolveDevBundler(), not a runtime veto"
  );
  assert.match(source, /resolveDevBundler\s*\(/, "run-next.mjs must call resolveDevBundler()");
  assert.match(
    source,
    /from\s+"\.\/bundler-flags\.mjs"/,
    "run-next.mjs must import the shared bundler decision"
  );
  // The webpack escape hatch still has to clear TURBOPACK, otherwise Next's
  // next-dev-server.js starts Turbopack regardless of the option passed to
  // next() (see the comment above the `delete` in run-next.mjs).
  assert.match(
    source,
    /if\s*\(!useTurbopack\)\s*\{\s*delete process\.env\.TURBOPACK;/,
    "the webpack path must still delete process.env.TURBOPACK"
  );
});
