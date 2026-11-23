#!/usr/bin/env sh
# ──────────────────────────────────────────────────────────────────────────────
#  proc-deploy.sh — deploy a PREBUILT OmniRoute image on a gateway host.
#
#  This script never builds anything. It pulls an immutable image tag, recreates
#  the compose stack with `up -d --no-build`, waits for the container health
#  probe, verifies the public API surface, and rolls back to the previous image
#  automatically when any gate fails.
#
#  It is the server half of docs/ops/PROC_HEADLESS_DEPLOY.md and is invoked by
#  .github/workflows/deploy-proc.yml (or by hand over SSH).
#
#  Usage:
#    sh scripts/ops/proc-deploy.sh <image-ref> [--dry-run] [--keep N]
#
#    <image-ref>   e.g. ghcr.io/owner/omniroute:proc-abc123def456
#                  (falls back to $OMNIROUTE_IMAGE when omitted)
#    --dry-run     print the plan and the compose config; change nothing
#    --keep N      keep the last N release records (default 3)
#
#  Optional environment:
#    GHCR_USERNAME / GHCR_TOKEN   registry login before pull (skipped when unset)
#    OMNIROUTE_COMPOSE_FILE       default: docker-compose.proc.yml
#    OMNIROUTE_HOST_PORT          dashboard host port to health-check (default 20130)
#    OMNIROUTE_SERVICE            compose service name (default omniroute)
#    OMNIROUTE_HEALTH_TIMEOUT     seconds to wait for /healthz (default 180)
#    OMNIROUTE_API_KEY            bearer token for the /v1/models gate (optional)
#    OMNIROUTE_HEALTHCHECK        container healthcheck command; auto-detected from
#                                 the image runtime when unset (node vs bun)
#    OMNIROUTE_MEM_LIMIT          container memory ceiling (default: compose value)
#    OMNIROUTE_MEMORY_MB          runtime V8 heap (default: compose value)
#    OMNIROUTE_HEADLESS           "1" (default) gates dashboard routes closed
#
#  Exit codes: 0 success · 1 usage/config error · 2 pull failed · 3 health gate
#  failed after deploy (rollback attempted) · 4 rollback failed (manual action).
# ──────────────────────────────────────────────────────────────────────────────
set -eu

COMPOSE_FILE="${OMNIROUTE_COMPOSE_FILE:-docker-compose.proc.yml}"
SERVICE="${OMNIROUTE_SERVICE:-omniroute}"
HOST_PORT="${OMNIROUTE_HOST_PORT:-20130}"
HEALTH_TIMEOUT="${OMNIROUTE_HEALTH_TIMEOUT:-180}"
RELEASES_FILE="${OMNIROUTE_RELEASES_FILE:-.proc-releases}"
KEEP=3
DRY_RUN=0
IMAGE=""

usage() {
  sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --keep)
      shift
      [ "$#" -gt 0 ] || usage
      KEEP="$1"
      ;;
    -h|--help) usage ;;
    --*)
      echo "unknown option: $1" >&2
      usage
      ;;
    *)
      [ -z "$IMAGE" ] || { echo "unexpected argument: $1" >&2; usage; }
      IMAGE="$1"
      ;;
  esac
  shift
done

[ -n "$IMAGE" ] || IMAGE="${OMNIROUTE_IMAGE:-}"
[ -n "$IMAGE" ] || { echo "error: no image given (argument or OMNIROUTE_IMAGE)" >&2; exit 1; }

# Dashboard availability follows the image variant, never a stale .env:
# web images ship the dashboard (headless=0), core images are API-only (headless=1).
# A stale .env previously left the dashboard answering "dashboard disabled (headless)".
case "$IMAGE" in
  *proc-web-*) OMNIROUTE_HEADLESS=0 ;;
  *) OMNIROUTE_HEADLESS=1 ;;
esac
export OMNIROUTE_HEADLESS

case "$IMAGE" in
  *:latest) echo "refusing to deploy a mutable 'latest' tag: $IMAGE" >&2; exit 1 ;;
esac

[ -f "$COMPOSE_FILE" ] || { echo "error: $COMPOSE_FILE not found in $(pwd)" >&2; exit 1; }
[ -f .env ] || { echo "error: .env not found in $(pwd) — create it from .env.example first" >&2; exit 1; }

log() { printf '[proc-deploy] %s\n' "$*"; }

# ── 0. Pre-flight: compose parses, current release is known ───────────────────
PREVIOUS_IMAGE="$(docker inspect "$SERVICE" --format '{{.Config.Image}}' 2>/dev/null || true)"
PREVIOUS_ID="$(docker inspect "$SERVICE" --format '{{.Image}}' 2>/dev/null || true)"
log "current image: ${PREVIOUS_IMAGE:-<none>} (${PREVIOUS_ID:-<none>})"
log "target image:  $IMAGE"

OMNIROUTE_IMAGE="$IMAGE" docker compose -f "$COMPOSE_FILE" config >/dev/null \
  || { echo "error: docker compose config rejected $COMPOSE_FILE" >&2; exit 1; }
log "compose config OK"

if [ "$DRY_RUN" = "1" ]; then
  log "--dry-run: would pull $IMAGE, run 'up -d --no-build', then gate /healthz and /v1/models"
  # SECURITY: never print `docker compose config` here. It resolves `env_file: .env`
  # and echoes every secret in cleartext (JWT_SECRET, API_KEY_SECRET,
  # INITIAL_PASSWORD, STORAGE_ENCRYPTION_KEY, MACHINE_ID_SALT). In CI that writes
  # production credentials into the Actions log. `--quiet` still validates the file
  # (exit code only), and the summary below is derived from the compose file text
  # rather than from the interpolated config.
  log "resolved image: $IMAGE"
  grep -E '^[[:space:]]*-[[:space:]]*"127\.0\.0\.1:' "$COMPOSE_FILE" 2>/dev/null | sed 's/^[[:space:]]*/  port /' || true
  log "secrets are NOT printed in dry-run (see the comment in this block)"
  exit 0
fi

# ── 1. Pull (never build) ────────────────────────────────────────────────────
if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USERNAME:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null
  log "logged in to ghcr.io as $GHCR_USERNAME"
fi

log "pulling $IMAGE"
if ! docker pull "$IMAGE"; then
  echo "error: docker pull failed for $IMAGE" >&2
  exit 2
fi
TARGET_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
log "pulled image id: $TARGET_ID"

# ── 1b. Detect the runtime + healthcheck command ─────────────────────────────
# The Node image (`runner-base`) ships `node healthcheck.mjs`; the Bun image
# (`runner-bun`) ships `bun healthcheck.mjs` and `node` inside it is NOT the Bun
# runtime. A hard-coded `node healthcheck.mjs` would mark a healthy Bun container
# unhealthy and trip the auto-rollback, so the probe follows the image.
#
# `node` and `bun` may both exist in a stage; what identifies the intended
# runtime is the PID 1 binary the image declares (Entrypoint/Cmd), with the
# presence of the runtime as a fallback.
detect_healthcheck() {
  # $1 = image ref to inspect (defaults to the target image)
  ref="${1:-$IMAGE}"
  if [ -n "${OMNIROUTE_HEALTHCHECK:-}" ]; then
    printf '%s' "$OMNIROUTE_HEALTHCHECK"
    return 0
  fi
  runtime="$(docker image inspect "$ref" \
    --format '{{join .Config.Entrypoint " "}} {{join .Config.Cmd " "}}' 2>/dev/null || true)"
  case "$runtime" in
    *bun*) printf 'bun healthcheck.mjs' ;;
    *node*) printf 'node healthcheck.mjs' ;;
    *)
      if docker run --rm --entrypoint sh "$ref" -c 'command -v bun >/dev/null 2>&1'; then
        printf 'bun healthcheck.mjs'
      else
        printf 'node healthcheck.mjs'
      fi
      ;;
  esac
}

HEALTHCHECK_CMD="$(detect_healthcheck "$IMAGE")"
case "$HEALTHCHECK_CMD" in
  "bun healthcheck.mjs"|"node healthcheck.mjs") ;;
  *)
    echo "error: refusing an unrecognised healthcheck command: $HEALTHCHECK_CMD" >&2
    echo "       expected 'node healthcheck.mjs' or 'bun healthcheck.mjs'" >&2
    exit 1
    ;;
esac
log "container healthcheck: $HEALTHCHECK_CMD"

# ── 1c. Persist the deployment knobs in the host .env ────────────────────────
# docker compose interpolates `${VAR:-default}` from the shell environment and
# from the project `.env`, but env_file values never participate in
# interpolation. The host `.env` therefore has to carry the deployment knobs
# (image, healthcheck, headless, memory ceilings) for `docker compose ps|up` run
# by hand later to resolve the same stack CI deployed. Only non-secret values are
# written; nothing here is ever echoed with a value.
persist_env() {
  key="$1"
  value="$2"
  [ -n "$value" ] || return 0
  touch .env
  if grep -q "^${key}=" .env; then
    # Rewrite in place without printing the old/new value.
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > "$tmp"
    cat "$tmp" > .env
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

persist_env OMNIROUTE_IMAGE "$IMAGE"
persist_env OMNIROUTE_HEALTHCHECK "$HEALTHCHECK_CMD"
if [ -n "${OMNIROUTE_HEADLESS:-}" ]; then persist_env OMNIROUTE_HEADLESS "$OMNIROUTE_HEADLESS"; fi
if [ -n "${OMNIROUTE_MEMORY_MB:-}" ]; then persist_env OMNIROUTE_MEMORY_MB "$OMNIROUTE_MEMORY_MB"; fi
if [ -n "${OMNIROUTE_MEM_LIMIT:-}" ]; then persist_env OMNIROUTE_MEM_LIMIT "$OMNIROUTE_MEM_LIMIT"; fi
log "host .env updated (image/healthcheck/headless/memory keys only)"

# ── 2. Recreate without building ─────────────────────────────────────────────
OMNIROUTE_IMAGE="$IMAGE" \
OMNIROUTE_HEALTHCHECK="$HEALTHCHECK_CMD" \
OMNIROUTE_HEADLESS="${OMNIROUTE_HEADLESS:-1}" \
  docker compose -f "$COMPOSE_FILE" up -d --no-build --remove-orphans
log "stack recreated (headless=${OMNIROUTE_HEADLESS:-1})"

# ── 3. Health gate ───────────────────────────────────────────────────────────
wait_health() {
  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    status="$(docker inspect "$SERVICE" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
    if [ "$status" = "healthy" ]; then
      # Deep gate: the process must answer both the lifecycle probe and the
      # models route — a healthy container whose routes 500 is not a deploy.
      if curl -fsS -m 5 "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null 2>&1; then
        if [ -n "${OMNIROUTE_API_KEY:-}" ]; then
          code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
            -H "Authorization: Bearer ${OMNIROUTE_API_KEY}" \
            "http://127.0.0.1:${HOST_PORT}/v1/models" || echo 000)"
        else
          code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
            "http://127.0.0.1:${HOST_PORT}/v1/models" || echo 000)"
        fi
        case "$code" in
          200|401) return 0 ;;   # 401 proves the route exists and auth is enforced
          *) log "healthz OK but /v1/models returned $code" ;;
        esac
      fi
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# Recreate with an explicit image ref. The compose healthcheck reads
# OMNIROUTE_HEALTHCHECK, so the rollback must set it too — otherwise rolling back
# a Bun release to a Node release (or the reverse) keeps the wrong probe.
recreate_with() {
  OMNIROUTE_IMAGE="$1" \
  OMNIROUTE_HEALTHCHECK="$HEALTHCHECK_CMD" \
  OMNIROUTE_HEADLESS="${OMNIROUTE_HEADLESS:-1}" \
    docker compose -f "$COMPOSE_FILE" up -d --no-build --remove-orphans
}

if wait_health; then
  log "health gate passed (healthz + /v1/models)"
else
  log "HEALTH GATE FAILED — rolling back to ${PREVIOUS_IMAGE:-$PREVIOUS_ID}"
  docker logs --tail 80 "$SERVICE" >&2 || true
  if [ -z "$PREVIOUS_IMAGE" ] && [ -z "$PREVIOUS_ID" ]; then
    echo "error: no previous image recorded; manual action required" >&2
    exit 4
  fi
  PREVIOUS_REF="${PREVIOUS_IMAGE:-$PREVIOUS_ID}"
  # The rollback target may be a different runtime than the failed release, so
  # re-detect its probe instead of reusing the new image's. An explicit
  # OMNIROUTE_HEALTHCHECK override still wins (detect_healthcheck honours it).
  ROLLBACK_HEALTHCHECK="$(detect_healthcheck "$PREVIOUS_REF")"
  # Same variant rule as the forward path: web images ship the dashboard.
  case "$PREVIOUS_REF" in
    *proc-web-*) ROLLBACK_HEADLESS=0 ;;
    *) ROLLBACK_HEADLESS=1 ;;
  esac
  OMNIROUTE_HEALTHCHECK="$ROLLBACK_HEALTHCHECK" \
    OMNIROUTE_IMAGE="$PREVIOUS_REF" \
    OMNIROUTE_HEADLESS="$ROLLBACK_HEADLESS" \
    docker compose -f "$COMPOSE_FILE" up -d --no-build --remove-orphans || exit 4
  persist_env OMNIROUTE_IMAGE "$PREVIOUS_REF"
  persist_env OMNIROUTE_HEALTHCHECK "$ROLLBACK_HEALTHCHECK"
  persist_env OMNIROUTE_HEADLESS "$ROLLBACK_HEADLESS"
  if wait_health; then
    log "rollback healthy — deployment aborted, previous release restored"
    exit 3
  fi
  echo "error: rollback also failed — manual action required" >&2
  exit 4
fi

# ── 4. Record the release + prune old records ────────────────────────────────
printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE" "$TARGET_ID" >> "$RELEASES_FILE"
log "release recorded in $RELEASES_FILE"

if [ "$KEEP" -gt 0 ] && [ -f "$RELEASES_FILE" ]; then
  total="$(wc -l < "$RELEASES_FILE" | tr -d ' ')"
  if [ "$total" -gt "$KEEP" ]; then
    drop=$((total - KEEP))
    tail -n "$drop" "$RELEASES_FILE" > "${RELEASES_FILE}.tmp"
    mv "${RELEASES_FILE}.tmp" "$RELEASES_FILE"
    log "trimmed $drop old release record(s), keeping $KEEP"
  fi
fi

log "deployed $IMAGE"
log "dashboard: $([ "$OMNIROUTE_HEADLESS" = "0" ] && echo enabled || echo 'disabled (headless)')"
log "API:       http://127.0.0.1:${HOST_PORT}/v1  (management: /api)"
