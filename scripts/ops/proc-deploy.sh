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
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
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

# ── 2. Recreate without building ─────────────────────────────────────────────
OMNIROUTE_IMAGE="$IMAGE" docker compose -f "$COMPOSE_FILE" up -d --no-build --remove-orphans
log "stack recreated"

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

if wait_health; then
  log "health gate passed (healthz + /v1/models)"
else
  log "HEALTH GATE FAILED — rolling back to ${PREVIOUS_IMAGE:-$PREVIOUS_ID}"
  docker logs --tail 80 "$SERVICE" >&2 || true
  if [ -z "$PREVIOUS_IMAGE" ] && [ -z "$PREVIOUS_ID" ]; then
    echo "error: no previous image recorded; manual action required" >&2
    exit 4
  fi
  OMNIROUTE_IMAGE="${PREVIOUS_IMAGE:-$PREVIOUS_ID}" \
    docker compose -f "$COMPOSE_FILE" up -d --no-build --remove-orphans || exit 4
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
log "dashboard: disabled (headless) unless OMNIROUTE_HEADLESS=0"
log "API:       http://127.0.0.1:${HOST_PORT}/v1  (management: /api)"
