#!/usr/bin/env node
/**
 * promote-proc.mjs — 把 dev 合并进 proc（部署分支）并推送。
 *
 * proc 只接受来自 dev 的合并提交；push 不带 --force，远端前进即失败而非覆盖。
 * 合并使用 --no-ff，保留 proc 的发布历史与上游合并轨迹。
 *
 * 用法：node scripts/ops/promote-proc.mjs [--dry-run]
 */

import { execFileSync } from "node:child_process";

const FORK = "fork";
const DEV = "dev";
const PROC = "proc";
const dryRun = process.argv.includes("--dry-run");

function git(args, { inherit = false, allowFail = false } = {}) {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    return String(out ?? "").trim();
  } catch (err) {
    if (allowFail) return null;
    console.error(
      `[FAIL] git ${args.join(" ")}\n${String(err.stderr ?? "").trim() || err.message}`
    );
    process.exit(1);
  }
}

git(["fetch", "--quiet", "--prune", FORK]);
const remoteProc = `refs/remotes/${FORK}/${PROC}`;
const forkProc = git(["rev-parse", "--verify", "--quiet", remoteProc], { allowFail: true });

if (!forkProc) {
  if (dryRun) {
    console.log(`dry-run: would create ${PROC} at the ${DEV} tip`);
    process.exit(0);
  }
  git(["switch", "-C", PROC, DEV]);
  git(["push", FORK, `${PROC}:${PROC}`], { inherit: true });
  console.log(`${PROC} created at ${git(["rev-parse", "--short=12", PROC])}`);
  process.exit(0);
}

const pending = Number(git(["rev-list", "--count", `${remoteProc}..${DEV}`]));
if (pending === 0) {
  console.log(`${PROC} already contains every ${DEV} commit — nothing to promote`);
  process.exit(0);
}
if (dryRun) {
  console.log(`dry-run: would merge ${pending} ${DEV} commit(s) into ${PROC}`);
  process.exit(0);
}

git(["switch", "-C", PROC, remoteProc]);
git(
  [
    "merge",
    "--no-ff",
    "--no-edit",
    DEV,
    "-m",
    "chore(release): merge dev into proc (auto upstream sync)",
  ],
  {
    inherit: true,
  }
);
git(["push", FORK, `${PROC}:${PROC}`], { inherit: true });
console.log(`${PROC} -> ${git(["rev-parse", "--short=12", PROC])}`);
