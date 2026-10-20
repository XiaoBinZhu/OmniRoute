// Loading for OPTIONAL native dependencies, kept out of the bundler's static graph.
//
// WHY THIS MODULE EXISTS
// ----------------------
// `better-sqlite3` and `keytar` are optionalDependencies: installs that skip the
// native build (Bun skips every lifecycle script unless the package is listed in
// `trustedDependencies`; npm 11+ refuses optional-dependency install scripts
// unless approved) leave them absent from node_modules while the rest of the
// tree is complete. Both packages are listed in `next.config.mjs`'s
// `serverExternalPackages`, which controls how a RESOLVED request is emitted —
// it does not stop the bundler from RESOLVING it first. A literal specifier
// therefore makes Next's Webpack emit
//
//   Warning: Module not found: Can't resolve 'better-sqlite3'
//
// once per compiled route, for a package whose absence is already the expected,
// heavily-defended case (see `src/lib/db/adapters/driverFactory.ts`). The
// `bin/cli/*` call sites are reachable from the Next.js server graph through
// `src/instrumentation-node.ts` → `src/lib/jobs/backupScheduleJob.ts` →
// `bin/cli/commands/backup.mjs`, which is why the warnings show up as
// "Import trace: Instrumentation" at dev-boot.
//
// Both exported loaders keep the specifier out of the analyzer's reach so the
// request is made by the RUNTIME, where the try/catch fallback chain that
// already exists at every call site stays in charge.
//
// Precedent in this repo (do not invent a third mechanism):
//   - `bin/cli/runtime/sqliteRuntime.mjs` uses `/* webpackIgnore: true */`.
//   - `src/lib/db/adapters/runtimeRequire.ts` uses `Reflect.apply` to keep a
//     request dynamic, with a literal `switch` for the CommonJS/build path.

/** Every specifier this module is allowed to load. */
export const OPTIONAL_NATIVE_SPECIFIERS = ["better-sqlite3", "keytar"];

function assertSupported(specifier) {
  if (!OPTIONAL_NATIVE_SPECIFIERS.includes(specifier)) {
    // Hard Rule #13 spirit: never build a module request from an unvalidated
    // runtime value. Every caller passes a literal, so this is a programming
    // error rather than a user-input path.
    throw new Error(
      `unsupported optional native dependency: ${JSON.stringify(specifier)} — ` +
        `add it to OPTIONAL_NATIVE_SPECIFIERS in bin/cli/runtime/opaqueImport.mjs first`
    );
  }
}

/**
 * Load an optional native dependency at RUNTIME, out of the bundler's static graph.
 *
 * ESM + CJS both work: Node's ESM loader and Bun resolve the real package, and
 * a missing package rejects. Callers keep their own try/catch — this function
 * never swallows a failure, exactly like a bare `await import(specifier)` would.
 *
 * @param {"better-sqlite3" | "keytar"} specifier
 * @returns {Promise<any>} the imported module namespace
 */
export async function importOptionalNative(specifier) {
  assertSupported(specifier);
  // webpackIgnore keeps Next's Webpack from resolving (and warning about) a
  // package that is legitimately absent; Turbopack leaves the request alone
  // because the specifier is not a statically analysable literal either way.
  switch (specifier) {
    case "better-sqlite3":
      return await import(/* webpackIgnore: true */ "better-sqlite3");
    case "keytar":
      return await import(/* webpackIgnore: true */ "keytar");
    default:
      // assertSupported already rejected anything that can reach here; the
      // throw keeps the function total for TypeScript's benefit.
      throw new Error(`unreachable optional native dependency: ${specifier}`);
  }
}

/**
 * CommonJS-side loader for the same optional native dependencies.
 *
 * The request goes through `Reflect.apply` so no analysable specifier appears
 * at this call site, mirroring `esmRuntimeRequire` in
 * `src/lib/db/adapters/runtimeRequire.ts`. A plain `require(specifier)` would be
 * rewritten by Webpack into its "missing module" stub — the failure mode
 * documented in `src/lib/db/adapters/driverFactory.ts` (its 80-120 line
 * comment), where every driver then reports itself as not installed even though
 * the addon is present on disk.
 *
 * The `require` is injected rather than built here so each caller keeps its own
 * resolution anchor, which is what `createRequire(import.meta.url)` is for.
 *
 * @param {typeof import("node:module").createRequire extends (u: any) => infer R ? R : never} requireFn
 *   a `require` produced by `createRequire(...)`
 * @param {"better-sqlite3" | "keytar"} specifier
 * @returns {any} the required module, or throws when it is not installed
 */
export function requireOptionalNative(requireFn, specifier) {
  assertSupported(specifier);
  if (typeof requireFn !== "function") {
    throw new TypeError("requireOptionalNative requires a require() from createRequire()");
  }
  return Reflect.apply(requireFn, undefined, [specifier]);
}
