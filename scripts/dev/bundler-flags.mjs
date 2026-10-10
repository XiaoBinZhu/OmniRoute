/**
 * Bundler validation for the dev/start runner (`scripts/dev/run-next.mjs`).
 *
 * Split out of the runner so the decision is a pure function of the environment
 * and the runtime version — testable without booting a Next.js server.
 *
 * Why this is not inlined any more
 * --------------------------------
 * The runner used to hard-disable Turbopack whenever the process ran under Bun
 * (`&& !isBun`, added with the native Bun backend in #11039). That premise no
 * longer holds: Turbopack is supported on Bun 1.4+ with Next 16.3 (#11471), and
 * the PRODUCTION build path never had the runtime check at all —
 * `resolveNextBuildBundlerFlag` in `scripts/build/build-next-isolated.mjs` reads
 * `OMNIROUTE_USE_TURBOPACK` alone. The result was a dev/build divergence: on
 * Bun, `bun run build` compiled with Turbopack while `bun run dev` silently
 * fell back to Webpack, paying the slower dev rebuild cost for no reason.
 *
 * The operator's explicit control is preserved: `OMNIROUTE_USE_TURBOPACK=0`
 * still forces Webpack on every runtime, and Bun < 1.4 keeps the old Webpack
 * default.
 */

/** First Bun release on which Turbopack dev is supported (with Next 16.3+). */
export const TURBOPACK_MIN_BUN = { major: 1, minor: 4 };

/**
 * Whether `OMNIROUTE_USE_TURBOPACK` explicitly asks for Webpack.
 *
 * Only the exact string `"0"` counts — that is the documented escape hatch
 * (`docs/reference/ENVIRONMENT.md`, #6409) and what CI passes when it wants
 * webpack. Any other value, including `"false"`, leaves the default alone; the
 * variable is parsed nowhere else, so tightening it here would silently diverge.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function isTurbopackDisabled(env = {}) {
  return env.OMNIROUTE_USE_TURBOPACK === "0";
}

/**
 * Whether a Bun version string satisfies the Turbopack floor.
 *
 * @param {string | undefined} bunVersion `process.versions.bun`, e.g. "1.4.2"
 * @returns {boolean} true when the version is >= {@link TURBOPACK_MIN_BUN}
 */
export function bunSupportsTurbopack(bunVersion) {
  if (!bunVersion) return false;
  const [major, minor] = String(bunVersion)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  if (major !== TURBOPACK_MIN_BUN.major) return major > TURBOPACK_MIN_BUN.major;
  return Number.isFinite(minor) ? minor >= TURBOPACK_MIN_BUN.minor : false;
}

/**
 * Resolve whether the dev server should use Turbopack.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   bunVersion?: string,
 *   dev?: boolean,
 * }} [options]
 * @returns {boolean} true → turbopack, false → webpack
 */
export function resolveDevBundler(options = {}) {
  const { env = {}, bunVersion = undefined, dev = true } = options;

  // `next start` is not a bundler decision — the build already happened.
  if (!dev) return false;

  // The operator's explicit escape hatch wins on every runtime.
  if (isTurbopackDisabled(env)) return false;

  // Node: Turbopack is the default (matches the Next 16 CLI default).
  if (!bunVersion) return true;

  // Bun 1.4+ matches the production build default; older Bun keeps Webpack.
  return bunSupportsTurbopack(bunVersion);
}
