import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_STAGING_ALLOWED_EXACT_PATHS,
  PACK_ARTIFACT_REQUIRED_PATHS,
} from "../../scripts/build/pack-artifact-policy.ts";
import { EXTRA_MODULE_ENTRIES } from "../../scripts/build/assembleStandalone.mjs";

// #7065 (3rd occurrence of this class — tls-options/3.8.41, head-response-guard/3.8.47):
// dist/server-ws.mjs imports sibling files that assembleStandalone copies into dist/,
// but the prepublish prune deletes anything not in APP_STAGING_ALLOWED_EXACT_PATHS and
// check:pack-artifact only fails for entries in PACK_ARTIFACT_REQUIRED_PATHS. Any local
// import missing from EITHER list ships a tarball that crashes on boot. This test derives
// the closure from the source of truth (the wrapper's own imports) so the class is closed.
//
// The 2026-10-20 43-box incident showed the class is TRANSITIVE: server-ws.mjs imports
// ./webdav-handler.mjs (allowlisted), and webdav-handler.mjs imported
// ../../bin/cli/runtime/opaqueImport.mjs. That path escapes the bundle root after the
// flatten copy and resolved to /bin/cli/runtime/opaqueImport.mjs → the container died at
// boot with ERR_MODULE_NOT_FOUND. A one-level check would not have caught it, so the walk
// below follows `./` imports through every shipped wrapper.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEV = path.join(ROOT, "scripts", "dev");
const WRAPPER = path.join(DEV, "standalone-server-ws.mjs");

function localImportsOf(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const esm = [...src.matchAll(/from\s+"\.\/([^"]+)"/g)].map((m) => m[1]);
  const cjs = [...src.matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
  return [...new Set([...esm, ...cjs])];
}

function localImports(): string[] {
  return localImportsOf(WRAPPER);
}

/**
 * Follow `./x` imports through every shipped wrapper under scripts/dev and return the
 * full set of bundle-root file names the entrypoint needs (server-ws.mjs excluded).
 */
function transitiveLocalImports(): string[] {
  const seen = new Set<string>();
  const queue = localImportsOf(WRAPPER);

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);

    // Only wrappers that live in scripts/dev and are copied verbatim get walked; a
    // sibling name that does not exist there is already reported by the assertions.
    const next = path.join(DEV, name);
    if (!fs.existsSync(next) || !fs.statSync(next).isFile()) continue;
    queue.push(...localImportsOf(next));
  }

  return [...seen];
}

test("every server-ws.mjs local import survives the prepublish prune (allowlist)", () => {
  const missing = localImports().filter((f) => !APP_STAGING_ALLOWED_EXACT_PATHS.includes(f));
  assert.deepEqual(missing, [], `add to APP_STAGING_ALLOWED_EXACT_PATHS: ${missing.join(", ")}`);
});

test("every server-ws.mjs local import is enforced by check:pack-artifact (required)", () => {
  const missing = localImports().filter((f) => !PACK_ARTIFACT_REQUIRED_PATHS.includes(`dist/${f}`));
  assert.deepEqual(
    missing,
    [],
    `add dist/<file> to PACK_ARTIFACT_REQUIRED_PATHS: ${missing.join(", ")}`
  );
});

test("every TRANSITIVE local import survives the prepublish prune (allowlist)", () => {
  const missing = transitiveLocalImports().filter(
    (f) => !APP_STAGING_ALLOWED_EXACT_PATHS.includes(f)
  );
  assert.deepEqual(missing, [], `add to APP_STAGING_ALLOWED_EXACT_PATHS: ${missing.join(", ")}`);
});

test("every TRANSITIVE local import is enforced by check:pack-artifact (required)", () => {
  const missing = transitiveLocalImports().filter(
    (f) => !PACK_ARTIFACT_REQUIRED_PATHS.includes(`dist/${f}`)
  );
  assert.deepEqual(
    missing,
    [],
    `add dist/<file> to PACK_ARTIFACT_REQUIRED_PATHS: ${missing.join(", ")}`
  );
});

test("no shipped wrapper escapes the bundle root, unless a same-name real file replaces it", () => {
  // The flatten copy rewrites the directory depth: `../../x` in scripts/dev resolves
  // outside the bundle root and becomes `/x` at runtime. A wrapper may only escape when
  // assembleStandalone copies a REAL self-contained implementation to the same bundle-root
  // name (the documented shim pattern, e.g. httpClientAbortGuard.mjs / opaqueImport.mjs).
  const offenders: string[] = [];
  for (const name of transitiveLocalImports()) {
    const file = path.join(DEV, name);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (!/from\s+"\.\.\/|\brequire\("\.\.\//.test(src)) continue;

    const replacement = EXTRA_MODULE_ENTRIES.find(
      (e: { src: string[]; dest: string[] }) =>
        e.dest.join("/") === name && !(e.src[0] === "scripts" && e.src[1] === "dev")
    );
    if (!replacement) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `escaping wrappers without a same-name replacement (add a scripts/dev shim): ${offenders.join(", ")}`
  );
});

test("sanity: the wrapper actually has local imports (regex not silently broken)", () => {
  assert.ok(localImports().length >= 5, `parsed only ${localImports().length} imports`);
});

test("sanity: the transitive walk reaches webdav-handler's own imports", () => {
  const reachable = transitiveLocalImports();
  assert.ok(reachable.includes("webdav-handler.mjs"), "webdav-handler.mjs not reached");
  assert.ok(reachable.includes("opaqueImport.mjs"), "opaqueImport.mjs not reached");
});
