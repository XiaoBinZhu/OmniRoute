import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRA_MODULE_ENTRIES } from "../../../scripts/build/assembleStandalone.mjs";

// Regression guard for the 2026-10-20 43-box boot crash.
//
// `scripts/dev/webdav-handler.mjs` is flattened to the bundle root, so its import of
// `./opaqueImport.mjs` must resolve there. `opaqueImport.mjs` is not reached by Next's
// NFT tracing (it is a dynamic-require helper), so assembleStandalone has to copy it
// explicitly. Without the copy the container dies at boot with
// ERR_MODULE_NOT_FOUND: /bin/cli/runtime/opaqueImport.mjs.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEV = path.join(ROOT, "scripts", "dev");

function entryFor(dest: string[]) {
  return EXTRA_MODULE_ENTRIES.find((e: { dest: string[] }) => e.dest.join("/") === dest.join("/"));
}

test("assembleStandalone ships opaqueImport.mjs at the bundle root", () => {
  const entry = entryFor(["opaqueImport.mjs"]);
  assert.ok(entry, "no EXTRA_MODULE_ENTRIES entry copies opaqueImport.mjs to the bundle root");
  assert.deepEqual(entry.src, ["bin", "cli", "runtime", "opaqueImport.mjs"]);
});

test("the shipped opaqueImport.mjs source exists and is self-contained", () => {
  const src = path.join(ROOT, "bin", "cli", "runtime", "opaqueImport.mjs");
  assert.ok(fs.existsSync(src), `${src} is missing — the copy would silently skip`);
  const body = fs.readFileSync(src, "utf8");
  // No relative imports of its own: it must survive being copied next to the wrappers.
  assert.equal(
    /from\s+"\.\.?\//.test(body),
    false,
    "opaqueImport.mjs must not use relative imports"
  );
});

test("webdav-handler imports its sibling shim, never ../../bin", () => {
  const body = fs.readFileSync(path.join(DEV, "webdav-handler.mjs"), "utf8");
  assert.match(body, /from\s+"\.\/opaqueImport\.mjs"/);
  assert.equal(
    /from\s+"\.\.\/\.\.\/bin\//.test(body),
    false,
    "the flattened bundle root turns ../../bin into /bin and crashes at boot"
  );
});

test("the scripts/dev opaqueImport shim points at the real implementation", () => {
  const shim = path.join(DEV, "opaqueImport.mjs");
  assert.ok(fs.existsSync(shim), "missing scripts/dev/opaqueImport.mjs shim");
  const body = fs.readFileSync(shim, "utf8");
  assert.match(body, /from\s+"\.\.\/\.\.\/bin\/cli\/runtime\/opaqueImport\.mjs"/);
  assert.match(body, /requireOptionalNative/);
  assert.match(body, /importOptionalNative/);
});
