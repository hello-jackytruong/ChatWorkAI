#!/usr/bin/env bash
# Ubuntu host entry point. Never source .env, remove volumes, or restore a DB automatically.
set -Eeuo pipefail
umask 077
ROOT="${CHATWORK_DEPLOY_ROOT:-/opt/chatworkai}"
RELEASE_PATTERN="^[0-9a-f]{40}(-[0-9]+-[0-9]+)?$"
STATE="$ROOT/state"
APPS=(javascript-executor builder realtime mcp zalo-account-gateway worker)
fail() { echo "ERROR: $*" >&2; exit 1; }
[[ "$ROOT" =~ ^/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)+$ ]] || fail 'Use an absolute deployment path without spaces or quotes'
mkdir -p "$STATE" "$ROOT/backups" "$ROOT/logs"
if [[ "${CHATWORK_DEPLOY_LOCK_FD:-}" != 9 || ! -e /proc/$$/fd/9 ]]; then
  exec 9>"$ROOT/deploy.lock"
fi
flock -n 9 || fail 'Another deployment or backup is running'

use_release() {
  local release="$1"
  [[ "$release" =~ $RELEASE_PATTERN ]] || fail 'Invalid release SHA'
  RELEASE_DIR="$ROOT/releases/$release"
  [[ -f "$RELEASE_DIR/docker-compose.production.yml" && -f "$RELEASE_DIR/image-prefix" ]] || fail 'Release bundle missing'
  export CHATWORK_RELEASE_SHA="${release:0:40}"
  export CHATWORK_ENV_FILE="$RELEASE_DIR/.env"
  [[ -f "$CHATWORK_ENV_FILE" ]] || export CHATWORK_ENV_FILE="$ROOT/.env"
  [[ -f "$CHATWORK_ENV_FILE" ]] || fail 'Missing production .env'
  [[ "$(stat -c %a "$CHATWORK_ENV_FILE")" == 600 ]] || fail '.env must have mode 0600'
  CHATWORK_IMAGE_PREFIX="$(cat "$RELEASE_DIR/image-prefix")"
  export CHATWORK_IMAGE_PREFIX
  [[ "$CHATWORK_IMAGE_PREFIX" =~ ^ghcr.io/[a-z0-9_-]+/[a-z0-9_.-]+$ ]] || fail 'Invalid image namespace'
  # Compose gives shell exports priority over --env-file. Keep only deployment
  # and Docker routing variables so GitHub dotenv stays the source of truth.
  COMPOSE=(env -i "PATH=$PATH" "HOME=${HOME:-/root}"
    "DOCKER_CONFIG=${DOCKER_CONFIG:-${HOME:-/root}/.docker}"
    "DOCKER_HOST=${DOCKER_HOST:-}" "DOCKER_CONTEXT=${DOCKER_CONTEXT:-}"
    "CHATWORK_DEPLOY_ROOT=$ROOT" "CHATWORK_ENV_FILE=$CHATWORK_ENV_FILE"
    "CHATWORK_RELEASE_SHA=$CHATWORK_RELEASE_SHA" "CHATWORK_IMAGE_PREFIX=$CHATWORK_IMAGE_PREFIX"
    docker compose --project-directory "$ROOT" --env-file "$CHATWORK_ENV_FILE" -f "$RELEASE_DIR/docker-compose.production.yml")
}

validate() {
  "${COMPOSE[@]}" config --quiet
  # Keep secret-bearing rendered config inside a pipe, never in Actions logs.
  "${COMPOSE[@]}" config --format json | python3 "$RELEASE_DIR/scripts/deployment/validate-production.py"
}

validate_transition() {
  local previous="$1"
  [[ "$previous" =~ $RELEASE_PATTERN ]] || return 0
  "${COMPOSE[@]}" config --format json | python3 "$RELEASE_DIR/scripts/deployment/compare-production.py" <(
    use_release "$previous"
    "${COMPOSE[@]}" config --format json
  )
}

read_env_key() {
  "${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["builder"]["environment"].get(sys.argv[1], ""))' "$1"
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

point_env() {
  local release="$1"
  if [[ -f "$ROOT/releases/$release/.env" ]]; then
    rm -f "$ROOT/.env.next"
    ln -s "releases/$release/.env" "$ROOT/.env.next"
    mv -Tf "$ROOT/.env.next" "$ROOT/.env"
  fi
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
      approved="$(read_env_key APPROVED_MIGRATION_DIGEST)"
      [[ "$approved" == "$digest" ]] || fail "Migration approval required: review SQL and set APPROVED_MIGRATION_DIGEST=$digest"
    fi
    previous="$(basename "$(readlink -f "$ROOT/current" 2>/dev/null || true)")"
    validate_transition "$previous"
    # Pull before touching live containers; verify the revision of every image.
    "${COMPOSE[@]}" pull "${APPS[@]}"
    for service in "${APPS[@]}"; do
      image="$CHATWORK_IMAGE_PREFIX/chatworkai-$service:sha-$CHATWORK_RELEASE_SHA"
      revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
      [[ "$revision" == "$CHATWORK_RELEASE_SHA" ]] || fail "Image revision mismatch: $service"
    done
    # Existing datastores are never recreated by a normal release.
    "${COMPOSE[@]}" up -d --no-recreate --wait --wait-timeout 180 postgres redis
    backup
    if [[ "$digest" != "$applied" ]]; then
      "${COMPOSE[@]}" run --rm --no-deps builder migrate
      printf '%s\n' "$digest" >"$STATE/migrations.sha256.next"
      mv "$STATE/migrations.sha256.next" "$STATE/migrations.sha256"
    fi
    if [[ ! "$previous" =~ $RELEASE_PATTERN && ! -e "$STATE/seeded" && "$(read_env_key INITIAL_SEED_APPROVED)" == true ]]; then
      "${COMPOSE[@]}" run --rm --no-deps builder seed
      touch "$STATE/seeded"
    fi
    if ! activate; then
      echo 'Activation failed; attempting previous application images (database is not reversed)' >&2
      if [[ "$previous" =~ $RELEASE_PATTERN ]]; then
        use_release "$previous"
        restore_apps || fail 'Application rollback also failed; inspect restricted host logs'
      else
        # First release has no healthy predecessor. Stop the partial app set.
        "${COMPOSE[@]}" stop "${APPS[@]}" || true
      fi
      fail 'Release failed readiness checks'
    fi
    [[ ! "$previous" =~ $RELEASE_PATTERN || "$previous" == "$sha" ]] || point_to previous "$previous"
    point_to current "$sha"
    point_env "$sha"
    echo "Activated release $sha"
    ;;
  rollback)
    previous="$(basename "$(readlink -f "$ROOT/previous")")"
    use_release "$previous"
    validate
    restore_apps || fail 'Rollback readiness checks failed'
    point_to previous "$sha"
    point_to current "$previous"
    point_env "$previous"
    echo 'Previous application release restored; schema left unchanged'
    ;;
  *) fail 'Usage: production.sh check|deploy SHA|backup|rollback' ;;
esac
