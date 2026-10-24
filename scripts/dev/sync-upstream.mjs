#!/usr/bin/env node
/**
 * sync-upstream.mjs — one command to sync this fork with upstream.
 *
 * This repository is a FORK. Two branches matter:
 *
 *   main — a pristine mirror of upstream. It must always equal the upstream
 *          tip, so nothing of yours lives here. Never commit on `main`.
 *   dev  — where you work. It merges upstream and carries your changes.
 *
 * The command does six steps, stopping on the first failure:
 *
 *   1. Working tree must be clean (a merge must never land on your edits).
 *   2. Fetch upstream + fork.
 *   3. Fast-forward local `main` to the upstream tip.
 *   4. Push `main` to the fork (the mirror), guarded by --force-with-lease.
 *   5. Merge upstream into `dev`.
 *   6. Push `dev` to the fork.
 *
 * Usage (from the repository root):
 *     node scripts/dev/sync-upstream.mjs
 *     node scripts/dev/sync-upstream.mjs --dry-run    report only, write nothing
 *     node scripts/dev/sync-upstream.mjs --branch release/vX.Y.Z   pin the upstream branch
 *
 * The upstream branch defaults to the highest `release/vX.Y.Z` on the upstream
 * remote (upstream's active development branch), detected on every run.
 * SYNC_UPSTREAM_BRANCH=<name> is equivalent to --branch.
 *
 * Safety rules this script honours:
 *   - `main` is only ever pushed with --force-with-lease, and only AFTER a fresh
 *     fetch, so a remote commit we have not seen makes the push FAIL rather than
 *     overwrite it. Failing is preferable to losing data.
 *   - No other branch is ever touched.
 *   - `git stash` is never used (Hard Rule #22a bans it in this repository).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const UPSTREAM = "origin";
const FORK = "fork";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const branchFlag = argv.indexOf("--branch");
const branchOverride = branchFlag >= 0 ? argv[branchFlag + 1] : process.env.SYNC_UPSTREAM_BRANCH;

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const step = (m) => console.log(`\n${c.cyan("==>")} ${m}`);
const info = (m) => console.log(`  ${m}`);
const ok = (m) => console.log(`  ${c.green("[OK]")} ${m}`);
const warn = (m) => console.log(`  ${c.yellow("[!!]")} ${m}`);
function die(m) {
  console.log(`\n${c.red("[FAIL]")} ${m}`);
  process.exit(1);
}

/** Run git; returns trimmed stdout. Throws on failure unless allowFail. */
function git(args, { allowFail = false, inherit = false } = {}) {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    return out === null || out === undefined ? "" : String(out).trim();
  } catch (err) {
    if (allowFail) return null;
    const stderr = (err.stderr || "").toString().trim();
    die(`git ${args.join(" ")} failed:\n${stderr || err.message}`);
  }
}

/** Move local `main` to `sha` without checking it out (we stay on dev). */
function moveMainTo(sha) {
  git(["fetch", "--quiet", FORK, `+${sha}:main`]);
  return git(["rev-parse", "main"]);
}

const short = (s) => String(s ?? "absent").slice(0, 10);

/** Highest upstream `release/vX.Y.Z` by numeric version (upstream's active branch). */
function detectUpstreamBranch() {
  const out = git(["ls-remote", "--heads", UPSTREAM, "refs/heads/release/v*"]);
  const versions = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/refs\/heads\/(release\/v(\d+)\.(\d+)\.(\d+))$/);
    if (m) versions.push({ name: m[1], v: [Number(m[2]), Number(m[3]), Number(m[4])] });
  }
  if (versions.length === 0) die(`No release/vX.Y.Z branch found on '${UPSTREAM}'.`);
  versions.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return versions[0].name;
}

// --- 0. environment ----------------------------------------------------------
if (!existsSync(".git")) die("Not a git repository root. Run this from the repo root.");

const remotes = (git(["remote"]) || "").split(/\r?\n/);
for (const r of [UPSTREAM, FORK]) {
  if (!remotes.includes(r)) {
    die(`Remote '${r}' not found. Existing remotes: ${remotes.join(", ")}`);
  }
}

const startBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const UPSTREAM_BRANCH = branchOverride || detectUpstreamBranch();
info(`repo:     ${process.cwd()}`);
info(`branch:   ${startBranch}`);
info(
  `upstream: ${UPSTREAM}/${UPSTREAM_BRANCH}${branchOverride ? " (override)" : " (auto-detected)"}`
);

// --- 1. clean working tree ---------------------------------------------------
step("1/6 check working tree");
const dirty = git(["status", "--porcelain=v1"]);
if (dirty) {
  console.log(dirty);
  die("Working tree has uncommitted changes. Commit or discard them first.");
}
ok("working tree is clean");

// --- 2. fetch ----------------------------------------------------------------
step("2/6 fetch upstream + fork");
git(["fetch", "--quiet", UPSTREAM, UPSTREAM_BRANCH]);
git(["fetch", "--quiet", "--prune", FORK]);
const upstreamRef = `${UPSTREAM}/${UPSTREAM_BRANCH}`;
const upstreamTip = git(["rev-parse", upstreamRef]);
ok(`${upstreamRef} = ${short(upstreamTip)}`);

// --- 3. fast-forward local main to the upstream tip --------------------------
step("3/6 align local main with the upstream tip");
const mainBefore = git(["rev-parse", "main"], { allowFail: true }) || undefined;
if (mainBefore === upstreamTip) {
  ok(`main already equals the upstream tip (${short(mainBefore)})`);
} else if (dryRun) {
  warn(`dry-run: main ${short(mainBefore)} -> ${short(upstreamTip)} (not executed)`);
} else {
  const mainAfter = moveMainTo(upstreamTip);
  if (mainAfter !== upstreamTip)
    die(`main did not reach the upstream tip (now ${short(mainAfter)}).`);
  ok(`main ${short(mainBefore)} -> ${short(mainAfter)}`);
}

// --- 4. push main to the fork ------------------------------------------------
step("4/6 push main -> fork (the mirror)");
const forkMainBefore = git(["rev-parse", `${FORK}/main`], { allowFail: true }) || undefined;
if (dryRun) {
  if (forkMainBefore === upstreamTip) ok("fork/main already equals the upstream tip");
  else warn(`dry-run: would push fork/main to ${short(upstreamTip)} (not executed)`);
} else {
  // Re-fetch so --force-with-lease has a trustworthy base: if the remote main
  // moved to a commit we have never seen, the push is REJECTED, not forced.
  git(["fetch", "--quiet", FORK, "main"]);
  const stillThere = git(["rev-parse", `${FORK}/main`], { allowFail: true }) || undefined;
  if (stillThere !== forkMainBefore) {
    die(
      `fork/main changed after we looked (${short(forkMainBefore)} -> ${short(stillThere)}).\n` +
        "       Stopping instead of overwriting somebody else's commit."
    );
  }
  if (forkMainBefore === upstreamTip) {
    ok("fork/main already equals the upstream tip, nothing to push");
  } else {
    try {
      git(["push", `--force-with-lease=${FORK}/main:${forkMainBefore}`, FORK, "main"], {
        inherit: true,
      });
    } catch {
      die("pushing main failed (the remote may have moved). Inspect it and retry.");
    }
    const after = git(["rev-parse", `${FORK}/main`], { allowFail: true }) || "?";
    if (after !== upstreamTip) die(`fork/main is still not the upstream tip (${short(after)}).`);
    ok(`fork/main ${short(forkMainBefore)} -> ${short(after)}`);
  }
}

// --- 5. merge upstream into dev ---------------------------------------------
step("5/6 merge upstream into dev");
const behind = Number(git(["rev-list", "--count", `dev..${upstreamRef}`]));
if (behind === 0) {
  ok("dev already contains every upstream commit");
} else if (dryRun) {
  warn(`dry-run: would merge ${behind} upstream commit(s) into dev (not executed)`);
} else {
  if (git(["rev-parse", "--abbrev-ref", "HEAD"]) !== "dev") git(["switch", "dev"]);
  try {
    git(["merge", "--no-ff", "--no-edit", upstreamRef], { inherit: true });
  } catch {
    warn("merging upstream into dev hit conflicts. Unmerged files:");
    console.log(git(["diff", "--name-only", "--diff-filter=U"], { allowFail: true }) || "");
    die("Resolve them, commit, then run this script again.");
  }
  ok(`dev merged ${behind} upstream commit(s)`);
}

// --- 6. push dev -------------------------------------------------------------
step("6/6 push dev -> fork");
if (dryRun) {
  warn("dry-run: would push dev (not executed)");
} else {
  const ahead = Number(git(["rev-list", "--count", `${FORK}/dev..dev`]));
  if (ahead === 0) {
    ok("fork/dev already in sync, nothing to push");
  } else {
    git(["push", FORK, "dev"], { inherit: true });
    ok(`pushed dev (${ahead} commit(s))`);
  }
}

// back to the branch we started on
if (!dryRun) {
  const now = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (now !== startBranch) {
    git(["switch", startBranch]);
    info(`switched back to ${startBranch}`);
  }
}

console.log(`\n${c.green("Done.")}`);
if (dryRun) {
  console.log(c.yellow("(dry-run: nothing was written)"));
} else {
  console.log(
    c.dim(
      "\nModel: `main` mirrors upstream and carries nothing of yours.\n" +
        "Work on `dev`; when you are happy, merge dev into main.\n" +
        'GitHub\'s "Sync fork" button is optional — this script already aligned main.'
    )
  );
}
