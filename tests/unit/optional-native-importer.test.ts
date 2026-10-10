import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPTIONAL_NATIVE_SPECIFIERS,
  importOptionalNative,
  requireOptionalNative,
} from "../../bin/cli/runtime/opaqueImport.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

// `better-sqlite3` and `keytar` are optionalDependencies whose native build is
// legitimately skipped on a Bun install (`package.json` has no
// `trustedDependencies`, so Bun runs no lifecycle scripts). They are listed in
// `next.config.mjs`'s `serverExternalPackages`, which governs how a RESOLVED
// request is emitted — it does not stop the bundler resolving it first. Literal
// specifiers at call sites reachable from `src/instrumentation-node.ts` →
// `src/lib/jobs/backupScheduleJob.ts` → `bin/cli/commands/backup.mjs` made
// Next's Webpack print "Module not found: Can't resolve 'better-sqlite3'" once
// per compiled route. These pin the fix: the request is made by the RUNTIME.

test("optional native loaders keep a supported-specifier allowlist", () => {
  assert.deepEqual(OPTIONAL_NATIVE_SPECIFIERS, ["better-sqlite3", "keytar"]);
});

test("importOptionalNative rejects an unsupported specifier", async () => {
  // Hard Rule #13 in spirit: never build a module request from an unvalidated
  // runtime value. Every caller passes a literal, so this is a programming
  // error and it must fail loudly instead of resolving something unexpected.
  await assert.rejects(
    () => importOptionalNative("sql.js"),
    /unsupported optional native dependency/,
    "an unlisted specifier must reject"
  );
});

test("requireOptionalNative rejects an unsupported specifier", () => {
  assert.throws(
    () => requireOptionalNative(() => ({}), "node:sqlite"),
    /unsupported optional native dependency/
  );
});

test("requireOptionalNative rejects a missing require()", () => {
  assert.throws(
    () => requireOptionalNative(undefined, "better-sqlite3"),
    /requires a require\(\) from createRequire\(\)/
  );
});

test("importOptionalNative surfaces a missing package as a catchable error", async () => {
  // Both packages are genuinely absent on this tree (Bun skips their native
  // build), which is exactly the state every call site must survive. The
  // contract is "rejects like a bare import() would", never "throws something
  // else" — each caller keeps its own try/catch and fallback chain.
  const outcome = await Promise.all(
    OPTIONAL_NATIVE_SPECIFIERS.map((specifier) =>
      importOptionalNative(specifier).then(
        () => "present",
        (error) => {
          assert.ok(error instanceof Error, "rejection must carry an Error");
          assert.ok(error.code, "the Node/Bun loader code must survive, e.g. ERR_MODULE_NOT_FOUND");
          return error.code;
        }
      )
    )
  );
  for (const code of outcome) {
    assert.ok(
      code === "present" || code === "ERR_MODULE_NOT_FOUND",
      `an absent optional native dep must reject with ERR_MODULE_NOT_FOUND, got ${code}`
    );
  }
});

test("requireOptionalNative returns the required module", () => {
  const sentinel = { ok: true };
  const fakeRequire = (specifier) => {
    assert.equal(specifier, "better-sqlite3");
    return sentinel;
  };
  assert.equal(requireOptionalNative(fakeRequire, "better-sqlite3"), sentinel);
});

// Source contracts: the literal specifiers must be gone from every call site
// that is reachable from the Next.js server bundle, and each one must go
// through the loader instead (removal alone would ship a silent no-op).
const CALL_SITES = [
  { file: "bin/cli/sqlite.mjs", specifier: "better-sqlite3" },
  { file: "bin/cli/contexts.mjs", specifier: "keytar" },
  { file: "bin/cli/runtime/sqliteRuntime.mjs", specifier: "better-sqlite3" },
  { file: "scripts/dev/sync-env.mjs", specifier: "better-sqlite3" },
  { file: "scripts/dev/webdav-handler.mjs", specifier: "better-sqlite3" },
  { file: "bin/cli/commands/reset-encrypted-columns.mjs", specifier: "better-sqlite3" },
];

for (const { file, specifier } of CALL_SITES) {
  test(`${file} loads ${specifier} through the opaque loader`, () => {
    const source = read(file);

    assert.doesNotMatch(
      source,
      new RegExp(`import\\(\\s*["']${specifier}["']\\s*\\)`),
      `${file} must not use a literal dynamic import() the bundler can follow`
    );
    assert.doesNotMatch(
      source,
      new RegExp(`(^|[^.\\w])require\\(\\s*["']${specifier}["']\\s*\\)`, "m"),
      `${file} must not use a literal require() the bundler can follow`
    );
    assert.match(
      source,
      /importOptionalNative\(|requireOptionalNative\(/,
      `${file} must load ${specifier} via importOptionalNative()/requireOptionalNative()`
    );
  });
}

test("the loader itself keeps the specifiers behind webpackIgnore", () => {
  const source = read("bin/cli/runtime/opaqueImport.mjs");
  for (const specifier of OPTIONAL_NATIVE_SPECIFIERS) {
    assert.match(
      source,
      new RegExp(`import\\(\\s*\\/\\* webpackIgnore: true \\*\\/\\s*["']${specifier}["']\\s*\\)`),
      `${specifier} must be imported with /* webpackIgnore: true */`
    );
  }
});

// next.config.mjs must keep externalising both packages: webpackIgnore removes
// the build warning, `serverExternalPackages` is what keeps the runtime request
// out of the server bundle in the first place. Dropping either one regresses a
// different half of the same bug (#11343 documents the interaction).
test("next.config.mjs still externalises both optional native packages", () => {
  const source = read("next.config.mjs");
  const externals = source.slice(
    source.indexOf("serverExternalPackages"),
    source.indexOf("transpilePackages")
  );
  for (const specifier of OPTIONAL_NATIVE_SPECIFIERS) {
    assert.match(
      externals,
      new RegExp(`"${specifier}"`),
      `serverExternalPackages must still list ${specifier}`
    );
  }
});
