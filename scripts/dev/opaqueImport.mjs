"use strict";

/**
 * Re-export of the CLI optional-native importer so the Node-only dev server
 * (`run-next.mjs`), the standalone WebDAV handler and the packaged wrappers all
 * import it from a sibling path.
 *
 * The real implementation lives in `bin/cli/runtime/opaqueImport.mjs` and is
 * self-contained (no relative imports of its own), so `assembleStandalone.mjs`
 * can ship it verbatim under the same file name at the bundle root.
 *
 * Why this shim exists (#webdav-headless-boot): `scripts/dev/webdav-handler.mjs`
 * imported `../../bin/cli/runtime/opaqueImport.mjs`. In the repo that resolves
 * correctly, but the standalone assembler flattens `webdav-handler.mjs` to the
 * bundle root — from there `../../bin` points at `/bin`, so the container died
 * at boot with `ERR_MODULE_NOT_FOUND: /bin/cli/runtime/opaqueImport.mjs`.
 * Importing `./opaqueImport.mjs` keeps the repo and the bundle layout identical
 * (same pattern as `scripts/dev/httpClientAbortGuard.mjs`).
 *
 * @module
 */

export {
  OPTIONAL_NATIVE_SPECIFIERS,
  importOptionalNative,
  requireOptionalNative,
} from "../../bin/cli/runtime/opaqueImport.mjs";
