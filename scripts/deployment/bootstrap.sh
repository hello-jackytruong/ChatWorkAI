#!/usr/bin/env bash
# Invoked over SSH with a private temporary directory containing GitHub secrets.
set -Eeuo pipefail
umask 077
ROOT="${1:?Deployment root required}"
RELEASE="${2:?Deployment id required}"
REPOSITORY="${3:?Repository required}"
ACTOR="${4:?Registry user required}"
SESSION="${5:?Private session directory required}"
fail() { echo "ERROR: $*" >&2; exit 1; }
[[ "$ROOT" =~ ^/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)+$ ]] || fail 'Invalid deployment root'
[[ "$RELEASE" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || fail 'Invalid deployment id'
[[ "$REPOSITORY" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || fail 'Invalid repository'
[[ "$ACTOR" =~ ^[a-zA-Z0-9_.-]+(\[bot\])?$ ]] || fail 'Invalid registry user'
[[ -s "$SESSION/production.env" && -s "$SESSION/github-token" && -f "$SESSION/migrations.sha256" ]] || fail 'Missing GitHub deployment secrets or metadata'
SHA="${RELEASE:0:40}"
privileged() {
  if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo -n "$@"; fi
}
# Docker/Nginx are host-owned prerequisites; install only small bootstrap tools.
if ! command -v git >/dev/null || ! command -v python3 >/dev/null || ! command -v flock >/dev/null; then
  privileged env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git python3 util-linux ca-certificates
fi
docker info >/dev/null 2>&1 || fail 'SSH user cannot access Docker'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose plugin is required'
if [[ ! -d "$ROOT" ]]; then
  mkdir -p "$ROOT" 2>/dev/null || privileged install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$ROOT"
fi
[[ -O "$ROOT" && ! -L "$ROOT" ]] || fail 'Deployment root must be an owned directory, not a symlink'
chmod 700 "$ROOT"
mkdir -p "$ROOT/releases" "$ROOT/logs" "$ROOT/state"
exec 8>"$ROOT/activation.lock"
flock -n 8 || fail 'Another bootstrap is running'
exec 9>"$ROOT/deploy.lock"
flock -n 9 || fail 'Another deployment or backup is running'
export CHATWORK_DEPLOY_LOCK_FD=9
[[ ! -e "$ROOT/releases/$RELEASE" ]] || fail 'Deployment id already exists; rerun the workflow for a new attempt'
# Restrict detailed output to the host. Never echo dotenv or authentication data.
exec >"$ROOT/logs/bootstrap-$RELEASE.log" 2>&1
export LC_ALL=C
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export CHATWORK_TOKEN_FILE="$SESSION/github-token"
export GIT_ASKPASS="$SESSION/git-askpass"
cat >"$GIT_ASKPASS" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) cat "$CHATWORK_TOKEN_FILE" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 700 "$GIT_ASKPASS"
URL="https://github.com/$REPOSITORY.git"
if [[ ! -d "$ROOT/repo/.git" ]]; then
  [[ ! -e "$ROOT/repo" ]] || fail 'Existing repo directory is not a Git checkout'
  git -c credential.helper= clone --depth=1 --branch dev "$URL" "$ROOT/repo"
else
  [[ "$(git -C "$ROOT/repo" remote get-url origin)" == "$URL" ]] || fail 'Existing checkout points at another repository'
  [[ -z "$(git -C "$ROOT/repo" status --porcelain)" ]] || fail 'Host checkout has local changes; refusing to overwrite'
fi
git -C "$ROOT/repo" -c credential.helper= fetch --no-tags --depth=1 origin "$SHA"
git -C "$ROOT/repo" checkout --detach "$SHA"
[[ "$(git -C "$ROOT/repo" rev-parse HEAD)" == "$SHA" ]] || fail 'Host checkout revision mismatch'
mkdir "$ROOT/releases/$RELEASE"
git -C "$ROOT/repo" archive "$SHA" docker-compose.production.yml scripts/deployment | tar -x -C "$ROOT/releases/$RELEASE"
# Source is exported from the verified commit; secrets are installed separately.
install -m 600 "$SESSION/production.env" "$ROOT/releases/$RELEASE/.env"
install -m 600 "$SESSION/migrations.sha256" "$ROOT/releases/$RELEASE/migrations.sha256"
printf 'ghcr.io/%s\n' "$(printf '%s' "$REPOSITORY" | tr '[:upper:]' '[:lower:]')" >"$ROOT/releases/$RELEASE/image-prefix"
# Upgrade older deployments to versioned env before changing the active pointer.
if [[ -L "$ROOT/current" && -f "$ROOT/.env" && ! -e "$ROOT/current/.env" ]]; then
  install -m 600 "$ROOT/.env" "$ROOT/current/.env"
fi
export DOCKER_CONFIG="$SESSION/docker"
mkdir -m 700 "$DOCKER_CONFIG"
docker login ghcr.io --username "$ACTOR" --password-stdin <"$SESSION/github-token" >/dev/null 2>&1 || fail 'GHCR authentication failed'
export CHATWORK_DEPLOY_ROOT="$ROOT"
bash "$ROOT/releases/$RELEASE/scripts/deployment/production.sh" deploy "$RELEASE"
