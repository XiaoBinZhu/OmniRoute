---
title: "Proc deployment — prebuilt image, headless gateway (no build on the host)"
version: 3.8.52
lastUpdated: 2026-10-20
---

# Proc deployment — prebuilt image, headless gateway

This page describes how the OmniRoute gateway image reaches a small host (the **43 box**:
2 vCPU / 3.7 GB RAM) **without ever building on that host**, and why the dashboard is not shipped
as a static bundle to Nginx.

Short version:

1. **Build once** — CI (`.github/workflows/deploy-proc.yml`) or a workstation with Docker builds
   the image and pushes it to GHCR.
2. **Pull only** — the host runs `docker compose -f docker-compose.proc.yml up -d --no-build`.
   `docker-compose.proc.yml` has no `build:` section at all.
3. **Headless by default** — the gateway image is built with
   `OMNIROUTE_BUILD_BACKEND_ONLY=1` and runs with `OMNIROUTE_HEADLESS=1`: `/v1/*` and `/api/*`
   are served, dashboard pages answer 404.
4. **Nginx is the front door** — it terminates the public surface and proxies `/v1/` and `/api/`
   to the loopback container (`config/deploy/nginx-omniroute.conf`).

---

## 1. Why the host must not build

The measured cost of a production build for this repository (see the `OMNIROUTE_BUILD_WORKERS`
comment in the `Dockerfile` and the 2026-10-20 incident in the MaaS phase-2 plan §65.7):

| item            | value                                                     |
| --------------- | --------------------------------------------------------- |
| build processes | 2 (parent + 1 page-data worker)                           |
| per-process RSS | ~4.5 GB, independent of `--max-old-space-size`            |
| total           | **~9 GB**                                                 |
| 43 box RAM      | 3.7 GB (+ swap)                                           |
| outcome         | two OOM kills at 2 GB and 4 GB heap, no standalone output |

`OMNIROUTE_BUILD_MEMORY_MB` cannot fix this — it bounds the V8 heap only, while Turbopack/webpack
worker RSS lives largely outside it.

## 2. What the two build profiles produce

| profile                            | build args                       | artifact                   | dashboard                                                                                    |
| ---------------------------------- | -------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| **core** (default for the gateway) | `OMNIROUTE_BUILD_BACKEND_ONLY=1` | API-only standalone        | pages stubbed, `/dashboard` + `/home` answer `404 {"error":"dashboard disabled (headless)"}` |
| full                               | none                             | dashboard + API standalone | complete UI                                                                                  |

The core profile is implemented by `scripts/build/backendOnlyPages.mjs`: before `next build`,
every App-Router UI file (`page/layout/template/loading/error/global-error/not-found/default`) is
replaced with a trivial stub and restored in a `finally` block (the files are git-tracked, so a
hard kill is recoverable with `git checkout -- src/app`). Every `route.ts` handler, `middleware`
and metadata route stays intact.

`package.json` exposes the same profile without Docker:

```bash
npm run build:backend     # OMNIROUTE_BUILD_BACKEND_ONLY=1 node scripts/build/build-next-isolated.mjs
npm run build             # full build (dashboard included)
```

### 2.2 Runtime choice: Node is the default, Bun is a measured downgrade

The gateway image is Node (`runner-base`). A Bun-runtime variant exists
(`runner-bun`, `oven/bun:1.4.3-slim`) but **it is not the default, and it is not a
memory win** — measured on the 2 vCPU / 3.7 GB gateway host with the same commit and
the same `builder` artifact, idle and warm:

| metric                  | Node `:proc-<sha>` | Bun `:proc-bun-<sha>`  |
| ----------------------- | ------------------ | ---------------------- |
| cgroup `memory.current` | **316.8 MiB**      | **413.6 MiB** (+30.6%) |
| cgroup `memory.peak`    | 356.9 MiB          | 552.9 MiB              |
| PID 1 `VmRSS`           | 57.8 MiB           | 25.5 MiB               |

The main process looks smaller under Bun because JSC's heap and compiled-code cache
live outside PID 1's RSS — but they are still charged to the cgroup, which is what a
4 GB host runs out of. Two further constraints:

- `bun run build` **cannot** produce this artifact (`module.createRequire failed
parsing argument` → `Could not parse output from TypeScript's --showConfig`), which
  is why `runner-bun` copies the **Node-built** standalone instead of building.
- Upstream tracks Bun as a best-effort compatibility target, not a supported runtime.

Use it only if you specifically need `bun:sqlite`/Bun semantics, and deploy it with:

```bash
OMNIROUTE_IMAGE=<repo>:proc-bun-<sha12>
OMNIROUTE_HEALTHCHECK='bun healthcheck.mjs'
```

`docker-compose.proc.yml` reads the probe from `OMNIROUTE_HEALTHCHECK` for exactly this
reason: `node` inside the Bun image is not the Bun runtime, so a hard-coded `node
healthcheck.mjs` would report a healthy container as unhealthy and trip the auto-rollback.

### 2.3 Model names: use a same-name combo, never a model alias

When the platform sends bare model names (`u2-flash`) but the credentials live on a
custom node (`openai-compatible-chat-ch8`), the obvious mapping — `PUT
/api/settings/model-aliases {"u2-flash":"openai-compatible-chat-ch8/u2-flash"}` — **breaks
inference**: the alias layer rewrites the already-prefixed id a second time and you get
`404 The model ... does not exist` or `401 No active credentials for provider`.

Create a **combo whose name is the platform model name** instead, pointing at the
prefixed model. That resolves without touching the caller:

```bash
POST /api/combos
{"name":"u2-flash","models":[{"model":"openai-compatible-chat-ch8/u2-flash"}],"strategy":"priority"}
```

Then sync each connection's catalogue so the node knows its models
(`POST /api/providers/<connectionId>/sync-models` — note: the id is the **connection
UUID**, not the provider id).

### 2.1 Headless runtime

`OMNIROUTE_HEADLESS=1` (or `omniroute serve --headless`) is the runtime counterpart. It is
implemented in `src/lib/system/headless.ts` and gated in `src/proxy.ts`; see
[HEADLESS.md](../guides/HEADLESS.md) for the full on/off table. It does **not** remove routes —
it closes the dashboard pages and skips dashboard-only boot subsystems (`live-dashboard-ws`,
`free-proxy-sync`, `cloud-sync`, …), while the management API the `omniroute` CLI uses stays
reachable.

## 3. Why the dashboard is not a static Nginx bundle

Serving the UI from Nginx as plain files would need a Next.js static export. It is not available
for this app, and the numbers are the reason:

| constraint                                          | measured                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| App-Router pages                                    | **149** `page.tsx`                                                |
| server components (no `"use client"`)               | **67** — they render on the server per request                    |
| dynamic segments (`[id]`, `[kind]`, `[...slug]`, …) | **10** route trees                                                |
| request-time interception                           | `src/proxy.ts` (authz pipeline, headless gate)                    |
| config-time routing                                 | `next.config.mjs` `rewrites()` + `redirects()` + security headers |

`output: "export"` requires no server rendering, no middleware/proxy and a `generateStaticParams`
for every dynamic segment; none of those hold. A static dashboard would be a multi-week refactor
of the entire UI with a high regression risk on a credentialed proxy.

**Therefore:** `config/deploy/nginx-omniroute.conf` proxies page requests to the container when
the **full** image is deployed (`OMNIROUTE_HEADLESS=0`), and proxies only `/v1/`, `/api/` and
`/healthz` when the **headless core** image is deployed. Nginx is still the only public entry
point, the container ports stay on loopback, and the host still never builds.

If a true static UI is required later, the isolated option is a dedicated dashboard-only build
(stub every `route.ts`, no proxy, `output: export`, `generateStaticParams` for the 10 dynamic
trees) — tracked as a separate change, not a deployment prerequisite.

## 4. Deploying

### 4.1 CI (recommended)

Push to `proc`, or run **Actions → deploy-proc → Run workflow**:

| input          | effect                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------- |
| `build_web`    | also build `:proc-web-<sha>` (full dashboard image)                                         |
| `deploy`       | deploy the freshly built image (only when `DEPLOY_ENABLED=true` on a manual run)            |
| `deploy_image` | `core` (headless API) or `web` (dashboard). `web` requires `build_web=true` in the same run |
| `build_bun`    | also build `:proc-bun-<sha>` (Bun runtime, same Node-built artifact)                        |

The build job publishes:

```
<IMAGE_REPOSITORY>:proc-<sha12>     # immutable — deploy this
<IMAGE_REPOSITORY>:proc             # moving alias of the same digest
<IMAGE_REPOSITORY>:proc-web-<sha12> # only with build_web=true
<IMAGE_REPOSITORY>:proc-bun-<sha12> # only with build_bun=true
```

`IMAGE_REPOSITORY` must be **lowercase** (for example `ghcr.io/xiaobinzhu/omniroute`). GHCR
rejects uppercase repository names — the first attempt failed with
`invalid tag "ghcr.io/XiaoBinZhu/omniroute:proc-…": repository name must be lowercase`.

**"Backend first, then frontend, then deploy" as a push pipeline.** With the repository variable
`DEPLOY_IMAGE_KIND=web`, a push to `proc` builds the headless core first, then the dashboard
image (`build-web`), and only then deploys the **dashboard** image with `OMNIROUTE_HEADLESS=0`.
`build-core` → `build-web` → `deploy` is expressed as job `needs`, so the order is enforced by the
runner and a failed dashboard build leaves the previous release untouched. Leave
`DEPLOY_IMAGE_KIND` unset (or `core`) to keep the headless API image as the deployed one; on a
manual dispatch the `deploy_image` input takes precedence.

The deploy job:

1. copies `docker-compose.proc.yml` and `scripts/ops/proc-deploy.sh` to `DEPLOY_PATH`;
2. logs the host in to GHCR with the read-only `GHCR_DEPLOY_TOKEN` (sent over SSH stdin, never on
   a command line);
3. resolves the image (`core` or `web`) and its `OMNIROUTE_HEADLESS` value (`1`/`0`);
4. runs `proc-deploy.sh <image>`, which pulls, recreates with `--no-build`, waits for `/healthz`
   **and** `/v1/models`, records the release and rolls back on failure.

The deploy script derives the container healthcheck from the image runtime (`node healthcheck.mjs`
for `runner-base`, `bun healthcheck.mjs` for `runner-bun`) unless `OMNIROUTE_HEALTHCHECK` is set,
and writes the non-secret deployment knobs (`OMNIROUTE_IMAGE`, `OMNIROUTE_HEALTHCHECK`,
`OMNIROUTE_HEADLESS`, the memory ceilings) into the host `.env`. Without that, a later manual
`docker compose up` would fall back to the compose defaults (`HEADLESS=1`, Node probe) and
silently turn the dashboard image back into a headless one.

### 4.2 From a workstation with Docker (air-gapped hosts)

```bash
# API-only image (what the gateway runs)
docker build --target runner-base -t omniroute:proc-core \
  --build-arg OMNIROUTE_USE_TURBOPACK=0 \
  --build-arg OMNIROUTE_BUILD_BACKEND_ONLY=1 \
  --build-arg OMNIROUTE_BUILD_MEMORY_MB=6144 \
  --build-arg OMNIROUTE_BUILD_WORKERS=2 .

# move it without a registry
docker save omniroute:proc-core | gzip -1 | \
  ssh morgan@43.155.185.180 'gunzip | docker load'
```

Then on the host:

```bash
cd /home/morgan/code/OmniRoute
export OMNIROUTE_IMAGE=omniroute:proc-core
docker compose -f docker-compose.proc.yml config      # inspect first
sh scripts/ops/proc-deploy.sh "$OMNIROUTE_IMAGE"
```

A Windows workstation has no Docker/WSL in this environment, so the CI path is the supported one
there — the image contains Linux native modules (`better-sqlite3`, `sqlite-vec`) and cannot be
produced on Windows anyway.

## 5. Verifying a deployment

```bash
docker compose -f docker-compose.proc.yml ps
docker inspect omniroute --format '{{.State.Health.Status}}'

curl -fsS http://127.0.0.1:20130/healthz                     # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:20130/v1/models
curl -s -w '\n%{http_code}\n' http://127.0.0.1:20130/dashboard
# {"error":"dashboard disabled (headless)"}
# 404
```

`/v1/models` returns `401` when `REQUIRE_API_KEY=true` — that still proves the route exists and
auth is enforced; the deploy script accepts `200` and `401` and nothing else.

## 6. Rollback

`OMNIROUTE_IMAGE` selects the release; the data volume is untouched.

```bash
cd /home/morgan/code/OmniRoute
tail -5 .proc-releases                 # written by proc-deploy.sh
export OMNIROUTE_IMAGE=<previous image ref>
docker compose -f docker-compose.proc.yml up -d --no-build
```

`proc-deploy.sh` performs this automatically when the health gate fails after a deploy, and keeps
the last `--keep` (default 3) release records.

## 7. Environment used by the compose file

| variable                                                      | default                     | meaning                                             |
| ------------------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| `OMNIROUTE_IMAGE`                                             | **required**                | immutable image ref (`:proc-<sha>`), never `latest` |
| `OMNIROUTE_HEADLESS`                                          | `1`                         | `0` only with a full/dashboard image                |
| `OMNIROUTE_MEMORY_MB`                                         | `768`                       | runtime V8 heap                                     |
| `OMNIROUTE_MEM_LIMIT`                                         | `1280m`                     | container memory ceiling                            |
| `OMNIROUTE_CPU_LIMIT`                                         | `1.5`                       | container CPU ceiling                               |
| `PROD_DASHBOARD_PORT` / `PROD_API_PORT` / `PROD_LIVE_WS_PORT` | `20130` / `20131` / `20132` | loopback host ports                                 |

The container also reads the host's `.env` (`env_file: .env`) — `JWT_SECRET`, `API_KEY_SECRET`,
`INITIAL_PASSWORD`, `REQUIRE_API_KEY`, `DATA_DIR` and friends. Never commit that file.

## 8. See also

- [HEADLESS.md](../guides/HEADLESS.md) — what headless mode turns off
- [DOCKER_GUIDE.md](../guides/DOCKER_GUIDE.md) — image flavours and compose profiles
- [SQLITE_RUNTIME.md](SQLITE_RUNTIME.md) — one writer per data directory (never run two replicas
  on the same volume)
- `docker-compose.proc.yml`, `scripts/ops/proc-deploy.sh`,
  `.github/workflows/deploy-proc.yml`, `config/deploy/nginx-omniroute.conf`
