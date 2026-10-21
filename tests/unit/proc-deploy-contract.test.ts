/**
 * tests/unit/proc-deploy-contract.test.ts
 *
 * Contract tests for the server half of the prebuilt-image deployment
 * (`scripts/ops/proc-deploy.sh` + `.github/workflows/deploy-proc.yml`).
 *
 * Why these exist (incident 2026-10-20/21): the 43 box (2 vCPU / 3.7 GB) cannot
 * run the Next.js production build (~9 GB RSS), so the host only pulls a
 * prebuilt image. Three gaps made the "automated" pipeline not actually
 * automated:
 *
 *   1. the workflow could only ever deploy the headless core image — the
 *      dashboard image had to be switched by hand on the host;
 *   2. the compose healthcheck was hard-coded to `node healthcheck.mjs`, so a
 *      Bun-runtime rollback target would be reported unhealthy;
 *   3. nothing wrote the deployment knobs back into the host `.env`, so the next
 *      manual `docker compose up` silently reverted to the compose defaults.
 *
 * The script is POSIX sh and the host has no test runner, so this suite pins the
 * contract statically (syntax + required behaviour) and executes the pure helper
 * functions in isolation. Anything that needs Docker/the host is covered by the
 * documented live verification, not here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "ops", "proc-deploy.sh");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "deploy-proc.yml");
const DOC = path.join(ROOT, "docs", "ops", "PROC_HEADLESS_DEPLOY.md");

const SH = resolveSh();
const hasSh = SH !== null;

/**
 * Locate a POSIX shell. CI (ubuntu-latest) always has `sh`; on a Windows dev box
 * it usually only exists inside the Git for Windows installation, so fall back to
 * the well-known locations instead of silently skipping the executable subtests.
 */
function resolveSh(): string | null {
  const probe = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
  if (probe.status === 0) return "sh";
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe"),
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "D:\\work\\Git\\usr\\bin\\sh.exe",
    "D:\\work\\Git\\bin\\sh.exe",
    "/usr/bin/sh",
    "/bin/sh",
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const r = spawnSync(candidate, ["-c", "echo ok"], { encoding: "utf8" });
    if (r.status === 0) return candidate;
  }
  return null;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Extract a POSIX shell function body (`name() { … }` up to the closing `}`). */
function extractFunction(body: string, name: string): string {
  const start = body.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `function ${name}() not found in proc-deploy.sh`);
  const end = body.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `function ${name}() is not terminated`);
  return body.slice(start, end + 3);
}

/**
 * Environment for the shell snippets. On Windows the Git-for-Windows `sh.exe`
 * finds its own coreutils only when its `usr/bin` is on PATH — invoking it
 * directly from a Node process inherits a Windows PATH without `grep`/`awk`/
 * `mktemp`, and every snippet would fail with "command not found".
 */
function shellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (SH && path.isAbsolute(SH)) {
    const binDir = path.dirname(SH);
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  }
  return env;
}

/** Run a snippet of POSIX sh with `sh -c`, returning trimmed stdout. */
function runSh(snippet: string): string {
  assert.ok(SH, "no POSIX shell available");
  const r = spawnSync(SH, ["-c", snippet], { encoding: "utf8", env: shellEnv() });
  assert.equal(r.status, 0, `sh snippet failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe("proc-deploy.sh contract", () => {
  it("is POSIX sh with strict mode and a usage banner", () => {
    const body = read(SCRIPT);
    assert.ok(body.startsWith("#!/usr/bin/env sh"), "must keep the /usr/bin/env sh shebang");
    assert.ok(body.includes("set -eu"), "must keep `set -eu`");
    assert.ok(body.includes("usage()"), "must keep the usage() banner");
  });

  it("passes `sh -n` (syntax check)", { skip: hasSh ? false : "sh not available" }, () => {
    const r = spawnSync(SH as string, ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, `syntax error: ${r.stderr}`);
  });

  it("refuses mutable tags and unknown healthcheck commands", () => {
    const body = read(SCRIPT);
    // `latest` must be rejected before any pull: it is the one tag that makes a
    // rollback record useless.
    assert.match(body, /\*:latest\)\s*echo "refusing to deploy a mutable 'latest' tag/);
    // The probe is interpolated into a compose file, so it may only be one of the
    // two shipped commands — never an arbitrary string.
    assert.match(body, /"bun healthcheck\.mjs"\|"node healthcheck\.mjs"/);
  });

  it("derives the healthcheck from the image runtime, not from a hard-coded node", () => {
    const body = read(SCRIPT);
    const fn = extractFunction(body, "detect_healthcheck");
    assert.match(fn, /Config\.Entrypoint/, "must inspect the image entrypoint/cmd");
    assert.match(fn, /\*bun\*\) printf 'bun healthcheck\.mjs'/);
    assert.match(fn, /\*node\*\) printf 'node healthcheck\.mjs'/);
    // An explicit override always wins (documented escape hatch).
    assert.match(fn, /OMNIROUTE_HEALTHCHECK/);
  });

  it(
    "detect_healthcheck returns the runtime's probe and honours the override",
    { skip: hasSh ? false : "sh not available" },
    () => {
      const body = read(SCRIPT);
      const fn = extractFunction(body, "detect_healthcheck");

      // Stub `docker image inspect` so the helper is testable without Docker.
      const harness = (entrypointCmd: string, override: string) => `
        docker() {
          if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
            printf '%s' '${entrypointCmd}'
            return 0
          fi
          return 0
        }
        IMAGE="ghcr.io/xiaobinzhu/omniroute:proc-test"
        OMNIROUTE_HEALTHCHECK='${override}'
        ${fn}
        detect_healthcheck "$IMAGE"
      `;

      assert.equal(
        runSh(harness("/app/check-permissions.sh node dev/run-standalone.mjs", "")),
        "node healthcheck.mjs"
      );
      assert.equal(runSh(harness("bun dev/run-standalone.mjs", "")), "bun healthcheck.mjs");
      // Override beats detection in both directions.
      assert.equal(
        runSh(harness("bun dev/run-standalone.mjs", "node healthcheck.mjs")),
        "node healthcheck.mjs"
      );
      assert.equal(
        runSh(
          harness("/app/check-permissions.sh node dev/run-standalone.mjs", "bun healthcheck.mjs")
        ),
        "bun healthcheck.mjs"
      );
    }
  );

  it(
    "persist_env rewrites a key in place, appends missing keys, and is idempotent",
    { skip: hasSh ? false : "sh not available" },
    () => {
      const body = read(SCRIPT);
      const fn = extractFunction(body, "persist_env");
      const dir = fs.mkdtempSync(path.join(ROOT, ".proc-deploy-test-"));
      try {
        const envFile = path.join(dir, ".env");
        fs.writeFileSync(
          envFile,
          ["NODE_ENV=production", "OMNIROUTE_HEADLESS=0", "JWT_SECRET=keep-me", ""].join("\n"),
          "utf8"
        );
        const snippet = `
          cd '${dir.replace(/\\/g, "/")}'
          ${fn}
          persist_env OMNIROUTE_IMAGE "ghcr.io/x/x:proc-abc"
          persist_env OMNIROUTE_HEADLESS "1"
          persist_env OMNIROUTE_HEALTHCHECK "node healthcheck.mjs"
          persist_env OMNIROUTE_IMAGE "ghcr.io/x/x:proc-abc"
        `;
        runSh(snippet);
        const after = fs.readFileSync(envFile, "utf8");
        const lines = after.split(/\r?\n/).filter(Boolean);

        // Unrelated secrets survive untouched…
        assert.ok(lines.includes("JWT_SECRET=keep-me"), "must not drop existing keys");
        assert.ok(lines.includes("NODE_ENV=production"));
        // …the key is rewritten, not duplicated…
        assert.equal(lines.filter((l) => l.startsWith("OMNIROUTE_IMAGE=")).length, 1);
        assert.ok(lines.includes("OMNIROUTE_IMAGE=ghcr.io/x/x:proc-abc"));
        // …and the stale value is gone.
        assert.equal(lines.filter((l) => l === "OMNIROUTE_HEADLESS=0").length, 0);
        assert.ok(lines.includes("OMNIROUTE_HEADLESS=1"));
        assert.ok(lines.includes("OMNIROUTE_HEALTHCHECK=node healthcheck.mjs"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  );

  it("never prints resolved secrets (the --dry-run regression)", () => {
    const body = read(SCRIPT);
    // `docker compose config` resolves env_file and echoes every secret; it may
    // only be used with output discarded. Match the invocation itself — not the
    // `|| { echo … }` failure branch on the following line.
    const invocations = body.split(/\r?\n/).filter((line) => {
      const t = line.trimStart();
      if (t.startsWith("#") || t.startsWith("||")) return false;
      return /docker compose .*\bconfig\b/.test(line);
    });
    assert.ok(invocations.length > 0, "expected a compose config validation call");
    for (const call of invocations) {
      assert.ok(
        call.includes(">/dev/null") || call.includes("--quiet"),
        `compose config output must be discarded: ${call.trim()}`
      );
    }
    // And the dry-run path must not fall back to printing the resolved config.
    const dryRun = body.slice(
      body.indexOf('if [ "$DRY_RUN" = "1" ]'),
      body.indexOf("# ── 1. Pull")
    );
    const dryRunCode = dryRun
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(
      dryRunCode,
      /docker compose .*config[^>]*$/m,
      "dry-run must not print compose config"
    );
  });
});

describe("deploy-proc.yml contract", () => {
  const yaml = read(WORKFLOW);

  it("keeps the build-then-deploy order (backend first, dashboard second)", () => {
    // `needs` is what actually enforces the order; a comment claiming it is not
    // enough (the first iteration of this workflow relied on prose).
    assert.match(yaml, /build-web:[\s\S]*?needs: build-core/);
    assert.match(yaml, /deploy:[\s\S]*?needs: \[build-core, build-web\]/);
  });

  it("exposes a deploy_image choice and only deploys the image that was built", () => {
    assert.match(yaml, /deploy_image:/);
    assert.match(yaml, /options: \[core, web\]/);
    // web requires the dashboard artifact; the guard must fail loudly otherwise.
    assert.match(yaml, /deploy_image=web but build-web did not produce an image/);
  });

  it("can automate 'core, then web, then deploy' on a push", () => {
    // Without this the dashboard release stays a manual dispatch, which is what
    // made the 43 host's UI look "deployed but not automated".
    assert.match(yaml, /DEPLOY_IMAGE_KIND/);
    assert.match(yaml, /github\.event_name == 'push' && vars\.DEPLOY_IMAGE_KIND == 'web'/);
  });

  it("passes the headless flag explicitly and lets the script pick the probe", () => {
    assert.match(yaml, /OMNIROUTE_HEADLESS='\$\{\{ steps\.target\.outputs\.headless \}\}'/);
    // Scope the probe assertion to the deploy step's SSH command: the Bun build
    // summary legitimately mentions `OMNIROUTE_HEALTHCHECK='bun healthcheck.mjs'`
    // as a manual-deploy hint, but the automated path must not pin it.
    const deployStep = yaml.slice(
      yaml.indexOf("- name: Deploy (pull, up --no-build, health gate, rollback)")
    );
    const deployCmd = deployStep.slice(0, deployStep.indexOf("- name: Summary"));
    assert.doesNotMatch(
      deployCmd,
      /OMNIROUTE_HEALTHCHECK=/,
      "the workflow must not pin the healthcheck: the script derives it from the image runtime"
    );
    assert.match(
      deployCmd,
      /OMNIROUTE_HEADLESS=/,
      "the deploy command must pass the headless flag"
    );
  });

  it("stays valid YAML with the expected jobs", async () => {
    const YAML = await import("js-yaml");
    const doc = YAML.load(yaml) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      jobs: Record<string, { needs?: string | string[]; if?: string }>;
    };
    assert.deepEqual(Object.keys(doc.jobs).sort(), [
      "build-core",
      "build-core-bun",
      "build-web",
      "deploy",
    ]);
    assert.deepEqual(doc.jobs.deploy.needs, ["build-core", "build-web"]);
    assert.ok(doc.on.workflow_dispatch.inputs.deploy_image);
    // `always()` is required: a skipped build-web would otherwise skip deploy.
    assert.match(doc.jobs.deploy.if ?? "", /always\(\)/);
  });
});

describe("PROC_HEADLESS_DEPLOY.md documents the automated path", () => {
  it("documents deploy_image, DEPLOY_IMAGE_KIND and the runtime-derived probe", () => {
    const doc = read(DOC);
    assert.match(doc, /deploy_image/);
    assert.match(doc, /DEPLOY_IMAGE_KIND/);
    assert.match(doc, /bun healthcheck\.mjs/);
    assert.match(doc, /node healthcheck\.mjs/);
    // The host .env write-back is the reason a manual `up` no longer reverts.
    assert.match(doc, /host `\.env`|host \.env/);
  });
});
