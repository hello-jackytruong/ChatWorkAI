#!/usr/bin/env bash
# Ubuntu host entry point. Never source .env, remove volumes, or restore a DB automatically.
set -Eeuo pipefail
umask 077
ROOT="${CHATWORK_DEPLOY_ROOT:-/opt/chatworkai}"
export CHATWORK_ENV_FILE="$ROOT/.env"
STATE="$ROOT/state"
APPS=(javascript-executor builder realtime mcp zalo-account-gateway worker)
fail() { echo "ERROR: $*" >&2; exit 1; }
[[ "$ROOT" == /* && "$ROOT" != *[\ \'\"]* ]] || fail 'Use an absolute deployment path without spaces or quotes'
mkdir -p "$STATE" "$ROOT/backups" "$ROOT/logs"
exec 9>"$ROOT/deploy.lock"
flock -n 9 || fail 'Another deployment or backup is running'
[[ -f "$CHATWORK_ENV_FILE" ]] || fail 'Missing production .env'
[[ "$(stat -c %a "$CHATWORK_ENV_FILE")" == 600 ]] || fail '.env must have mode 0600'

use_release() {
  local release="$1"
  [[ "$release" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid release SHA'
  RELEASE_DIR="$ROOT/releases/$release"
  [[ -f "$RELEASE_DIR/docker-compose.production.yml" && -f "$RELEASE_DIR/image-prefix" ]] || fail 'Release bundle missing'
  export CHATWORK_RELEASE_SHA="$release"
  CHATWORK_IMAGE_PREFIX="$(cat "$RELEASE_DIR/image-prefix")"
  export CHATWORK_IMAGE_PREFIX
  [[ "$CHATWORK_IMAGE_PREFIX" =~ ^ghcr.io/[a-z0-9_-]+/[a-z0-9_.-]+$ ]] || fail 'Invalid image namespace'
  COMPOSE=(docker compose --project-directory "$ROOT" --env-file "$CHATWORK_ENV_FILE" -f "$RELEASE_DIR/docker-compose.production.yml")
}

validate() {
  "${COMPOSE[@]}" config --quiet
  # Keep secret-bearing rendered config inside a pipe, never in Actions logs.
  "${COMPOSE[@]}" config --format json | python3 "$RELEASE_DIR/scripts/deployment/validate-production.py"
}

backup() {
  local output
  output="$ROOT/backups/postgres-$(date -u +%Y%m%dT%H%M%S)-$$.dump"
  # Expanded inside the container, not on the host.
  # shellcheck disable=SC2016
  "${COMPOSE[@]}" exec -T postgres sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$output.tmp" || {
    rm -f "$output.tmp"; fail 'Database backup failed';
  }
  if ! "${COMPOSE[@]}" exec -T postgres pg_restore --list <"$output.tmp" >/dev/null; then
    rm -f "$output.tmp"; fail 'Database backup validation failed'
  fi
  mv "$output.tmp" "$output"
  echo 'Database backup created and archive verified'
}

activate() {
  local service
  for service in "${APPS[@]}"; do
    "${COMPOSE[@]}" up -d --no-build --no-deps --pull never --wait --wait-timeout 300 "$service" || return 1
  done
}

restore_apps() {
  local service failed=0
  for service in "${APPS[@]}"; do
    "${COMPOSE[@]}" up -d --no-build --no-deps --pull never --wait --wait-timeout 300 "$service" || failed=1
  done
  return "$failed"
}

point_to() {
  local name="$1" sha="$2"
  rm -f "$ROOT/$name.next"
  ln -s "releases/$sha" "$ROOT/$name.next"
  mv -Tf "$ROOT/$name.next" "$ROOT/$name"
}

command="${1:-check}"
if [[ "$command" == deploy ]]; then
  sha="${2:?Expected release SHA}"
else
  sha="${2:-$(basename "$(readlink -f "$ROOT/current")")}"
fi
use_release "$sha"
validate
case "$command" in
  check) echo 'Production configuration valid' ;;
  backup) backup ;;
  deploy)
    digest="$(cat "$RELEASE_DIR/migrations.sha256")"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid migration digest'
    applied="$(cat "$STATE/migrations.sha256" 2>/dev/null || true)"
    if [[ "$digest" != "$applied" ]]; then
      approved="$("${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["builder"]["environment"].get("APPROVED_MIGRATION_DIGEST", ""))')"
      [[ "$approved" == "$digest" ]] || fail "Migration approval required: review SQL and set APPROVED_MIGRATION_DIGEST=$digest"
    fi
    # Pull before touching live containers; verify the revision of every image.
    "${COMPOSE[@]}" pull "${APPS[@]}"
    for service in "${APPS[@]}"; do
      image="$CHATWORK_IMAGE_PREFIX/chatworkai-$service:sha-$sha"
      revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
      [[ "$revision" == "$sha" ]] || fail "Image revision mismatch: $service"
    done
    previous="$(basename "$(readlink -f "$ROOT/current" 2>/dev/null || true)")"
    # Existing datastores are never recreated by a normal release.
    "${COMPOSE[@]}" up -d --no-recreate --wait --wait-timeout 180 postgres redis
    backup
    if [[ "$digest" != "$applied" ]]; then
      "${COMPOSE[@]}" run --rm --no-deps builder migrate
      printf '%s\n' "$digest" >"$STATE/migrations.sha256.next"
      mv "$STATE/migrations.sha256.next" "$STATE/migrations.sha256"
    fi
    if ! activate; then
      echo 'Activation failed; attempting previous application images (database is not reversed)' >&2
      if [[ "$previous" =~ ^[0-9a-f]{40}$ ]]; then
        use_release "$previous"
        restore_apps || fail 'Application rollback also failed; inspect restricted host logs'
      else
        # First release has no healthy predecessor. Stop the partial app set.
        "${COMPOSE[@]}" stop "${APPS[@]}" || true
      fi
      fail 'Release failed readiness checks'
    fi
    [[ ! "$previous" =~ ^[0-9a-f]{40}$ || "$previous" == "$sha" ]] || point_to previous "$previous"
    point_to current "$sha"
    echo "Activated release $sha"
    ;;
  rollback)
    previous="$(basename "$(readlink -f "$ROOT/previous")")"
    use_release "$previous"
    validate
    restore_apps || fail 'Rollback readiness checks failed'
    point_to previous "$sha"
    point_to current "$previous"
    echo 'Previous application release restored; schema left unchanged'
    ;;
  *) fail 'Usage: production.sh check|deploy SHA|backup|rollback' ;;
esac
