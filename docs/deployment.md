# Chatwork AI: Ubuntu + Cloudflare R2

Production releases come from **dev** via `.github/workflows/deploy-production.yml`.
The workflow reuses the full CI gate, builds six application images on GitHub,
then bootstraps Ubuntu, synchronizes the exact source revision and the production
dotenv from GitHub Secrets, and pulls images. The server never compiles source.
Local validation does not push code or deploy to a real server.

## Design and reference

Reviewed the reference checkout `/Users/jacky/Documents/GitHub/ChatbotX`:
`deploy-production.yml`, `ci.yml`, `docker-compose.production.yml`,
`production-full.sh`, and the backup/migration/activation/rollback paths in
`scripts/deployment/production.sh`. Retained quality gates, immutable revision
labels, bounded logs, host locks, verified backups and health-checked rollback.
Its Zalo Personal bridge, RustFS bootstrapping, separate deployment baselines and
hard-coded `/root/apps/ChatbotX` path are not applicable here. This repository
uses `apps/zalo-account-gateway` and external R2 instead.

All six application images are built for each dev push. This deliberately uses
a single coherent revision across builder/worker/realtime/MCP/executor/gateway;
selective deployment requires a reliable last-successful dependency baseline
and is not necessary for the initial deployment. The existing release workflow
continues to publish upstream-style images on main; production uses a distinct
repository-scoped namespace: `ghcr.io/<owner>/<repo>/chatworkai-<service>:sha-<sha>`.

## Configure GitHub once; server bootstrap is automatic

The Ubuntu server needs **Docker Engine + Compose, Nginx, and SSH access**.
Use x86_64 Ubuntu (images target `linux/amd64`). The SSH account must be able to
run Docker and write the deploy directory. Root works; a dedicated user can use
passwordless `sudo -n` for first-run package installation and creating `/opt/chatworkai`.
The bootstrap installs Git, Python 3, util-linux and CA certificates when missing.
No host Node.js, pnpm, repository clone, dotenv copy or permanent GHCR login is required.
Plan at least 8 GB RAM and enough disk for database, backups and current/previous
images. Only Nginx should be internet-facing; app ports bind to loopback and
Postgres/Redis have no published ports.

Configure the GitHub **production** environment (Settings → Environments →
production). Use **Secrets** for all credentials and the full dotenv:

| Setting | Kind | Value |
| --- | --- | --- |
| `PROD_HOST` | Secret | Ubuntu IP/DNS name |
| `PROD_USER` | Secret | SSH user with the permissions above |
| `PROD_SSH_KEY` | Secret | Dedicated private key; install its public half for the SSH user |
| `PROD_SSH_KNOWN_HOSTS` | Secret | Independently verified SSH host-key entry |
| `PROD_ENV_FILE` | Secret | Entire production `.env`, including R2 and application secrets |
| `PROD_PORT` | Optional secret | SSH port; defaults to `22` |
| `PROD_DEPLOY_ROOT` | Optional variable | Absolute deploy folder; defaults to `/opt/chatworkai` |

The deploy root must have at least two path segments and contain only letters,
digits, `_`, `-` and `/`, for example `/opt/chatworkai` or `/home/deploy/chatworkai`.
Root/system directories and trailing slashes are rejected. Pin the actual server
host key via a trusted route; do not blindly trust an unverified ssh-keyscan.
Do not require environment reviewers if unattended releases are desired.

Copy `scripts/deployment/production.env.example` into a **private local file**, fill
it with production values, then paste its entire content into `PROD_ENV_FILE`.
Alternatively, upload it without echoing values:

```bash
gh secret set PROD_ENV_FILE --env production < /private/path/production.env
```

This secret is the source of truth; stale application env exported by the SSH
account is excluded when Compose runs. To change mail/provider settings or another
ordinary env value, edit the GitHub secret and rerun the workflow on `dev`; no SSH
session or new code commit is needed. GitHub's per-secret size limit is 48 KB.
Use dotenv quoting: values containing literal `$` must be single-quoted so Compose
does not interpolate them. Do not put this dotenv in GitHub Variables, the Git
repository, Docker build arguments, logs, artifacts or caches. See
[GitHub Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

Retain existing application/integration settings from `.env.example` as needed.
Generate separate strong secrets. `ENCRYPTION_KEY` is 32 random bytes encoded as
64 hex characters. Preserve the existing encryption key and database credentials
when adopting an installation; URI-encode passwords in `DATABASE_URL`.

### What each workflow run does

1. Runs CI and builds revision-addressed images on GitHub, keeping existing SHA tags.
2. Streams dotenv, the job-scoped GitHub token, bootstrap script and migration
   fingerprint directly through verified SSH stdin into a mode-0700 temp directory.
3. Creates the deploy root; installs missing bootstrap tools; takes host locks.
4. Clones this repository into `repo/` if missing. Otherwise it fetches and checks
   out the **exact CI-tested SHA**, rather than pulling a moving branch. Dirty or
   wrong-repository checkouts fail instead of being reset or deleted.
5. Exports the verified revision's Compose/deployment scripts to
   `releases/<sha>-<run-id>-<attempt>/` and installs that
   release's dotenv with mode `0600`. The full source lives in `repo/`, avoiding
   a copy of the large source/snapshot tree per release. `.env` is never sourced as shell code.
6. Authenticates to GHCR with the job token using a temporary Docker config,
   validates env, pulls/verifies images, backs up the DB, runs pending migrations
   and any explicitly approved first-install seed, and starts/checks the services.
7. On success, switches `current` and the root `.env` link. On an activation failure,
   restores the previous image **and env**. An env change on a rerun of the same
   commit remains a separate deployment and preserves the previous dotenv.
8. Deletes temporary token, askpass and registry config files on exit, including
   error exits. No permanent Git or GHCR credentials are left on the host.

The automatic job token has `contents: read` and `packages: read`. No PAT or
server Git deploy key is needed for this repository. Repository-created GHCR
packages must grant this repository's Actions access (normally inherited from
the image source association). See [GHCR authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Changing an existing database's password/name/user, connection URL, data-volume
identity or application encryption key is not an ordinary dotenv update. The
transition validator rejects those changes before pulling/replacing services;
perform a separately planned credential/data migration instead. This prevents a
new secret value from disconnecting the old database or making saved tokens unreadable.

### Adopting an existing installation

Inventory existing volumes first. Set `POSTGRES_VOLUME_NAME` and
`REDIS_VOLUME_NAME` in the GitHub dotenv to the actual names. Never run two
Postgres processes against the same live volume: stop the old datastore
containers in a planned one-time cutover, preserving data/backups. Match existing
Postgres/Timescale versions; this Compose follows the repository's PG18 image.
Normal releases use `--no-recreate` for datastores and never pull/upgrade them.
An installation with real data should keep `INITIAL_SEED_APPROVED=false`.

## R2 setup and private/public separation

Create an R2 bucket and a bucket-scoped Object Read & Write S3 token. Set:

- `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`
- `S3_REGION=auto`
- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `NEXT_PUBLIC_STORAGE_URL=https://media.<your-domain>/`
- `NEXT_PUBLIC_INTERNAL_STORAGE_URL` to that same reader URL

R2 does not implement S3 object ACLs. `Uploader.putObject` omits ACL headers
only for R2 API hosts; S3/RustFS behavior remains unchanged. Existing object
keys and the public/private path conventions remain unchanged.

**Leave r2.dev and bucket public custom domains disabled.** The bucket also
contains private `workspace/` keys that must remain accessible only through
presigned URLs. Bind a custom media domain to the prefix-restricted Worker in
`deploy/r2/public-reader.mjs`, not directly to the bucket. It serves GET/HEAD
only under `public/`, including video ranges. To provision it once, copy
`wrangler.example.toml` to a private config, set the actual bucket/domain, then
run the authenticated Wrangler CLI with that explicit config. Keep local
Wrangler account configuration out of Git. Future Ubuntu deployments do not
change Cloudflare resources.

Apply `deploy/r2/cors.example.json` to R2 after replacing AllowedOrigins with
the exact production app origins (and localhost if using this bucket locally):

```bash
aws s3api put-bucket-cors --bucket "$S3_BUCKET" \
  --endpoint-url "$S3_ENDPOINT" \
  --cors-configuration file://deploy/r2/cors.example.json
```

Supply AWS-compatible credential environment variables through your private
credential manager; never put keys in command-line arguments. R2 API uploads
and signed downloads use the S3 endpoint; public files use the Worker domain.
Official contracts: [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/),
[browser CORS](https://developers.cloudflare.com/r2/buckets/cors/),
[Worker R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

### Existing RustFS/S3 data

Changing endpoints does **not** copy bytes. Before switching an existing
installation, use rclone with separately configured old/new remotes:

```bash
rclone copy old:OLD_BUCKET r2:NEW_BUCKET --checksum --progress
rclone check old:OLD_BUCKET r2:NEW_BUCKET --download
```

Retain all key prefixes, including `public/`, `workspace/`, and private AI files.
Do an initial copy, pause writes for the final delta copy/check, then switch
storage env and restart the local/production app processes. Keep the old bucket
for rollback. Update any tenant `storageUrl` overrides through the existing
platform settings and audit already persisted absolute external URLs. Verify
avatar, old image, video seeking, file upload/download, private attachments,
and AI file access before resuming writes. Do not set real local `.env` to
placeholder R2 credentials. Local RustFS Compose remains available for offline
development; use the same real R2 settings in local `.env` when credentials and
migration are ready.

## Deployment, automatic migrations and recovery

After setup, a dev push automatically runs CI, builds/pushes SHA images and
activates the release. The source checkout and temporary Git authentication are managed automatically. The workflow serializes the entire pipeline, and the host has separate
activation/data-operation locks. Failed pull, revision mismatch, invalid env
or failed migration stops before application replacement. Backups use
`pg_dump -Fc` and `pg_restore --list`; archive validation is not a restore drill.

Production deployment runs the migration runner after a verified backup on every
release. The runner records applied migrations in the database and executes only
pending SQL; no migration approval environment variable is needed. The migration
fingerprint is retained as diagnostic metadata, not as an approval gate. This is
the explicitly selected production automation policy; local/manual database
operations still follow the repository's approval rules. Image rollback does not
undo database schema changes, so migrations should remain backward-compatible.
For a new empty installation, set `INITIAL_SEED_APPROVED=true` in the
GitHub dotenv to explicitly approve the one-time `seed` command after migrations.
The seed completion marker prevents reseeding after a failed first activation;
normal upgrades with an existing current release never seed again. Leave it
false when adopting an existing database.

A deploy starts/reuses datastores, creates and verifies a DB backup, runs
pending migrations, then starts executor, builder, realtime, MCP, gateway and
worker with readiness waits. If activation fails, it attempts all previous app
images; on first-release failure it stops the partial app set. Running worker
checks establish process liveness, not successful queue throughput; verify a
real inbound/outbound message and queue progression as the initial smoke test.

State is in `/opt/chatworkai/current`, `/opt/chatworkai/previous`, and
`state/migrations.sha256`. Failed activations return nonzero to Actions;
detailed logs are retained in `logs/bootstrap-<sha>-<run-id>-<attempt>.log` with private permissions.

```bash
# Use the latest synchronized management code, also after rolling back to an older release.
cd /opt/chatworkai
./repo/scripts/deployment/production.sh check
./repo/scripts/deployment/production.sh backup
./repo/scripts/deployment/production.sh rollback
```

For a custom root, export `CHATWORK_DEPLOY_ROOT` before management commands.
Keep current/previous release directories (including their private dotenv files)
and image tags. The root `.env` is a link to the successful active release. The script never runs
`compose down`, deletes volumes, globally prunes images, or restores the DB.
Schedule daily backups through the host's existing backup manager, copy dumps
to encrypted off-host storage, set retention for dumps/logs/images, and test a
restore before relying on recovery. R2 also needs an independent object backup
policy; a database dump does not contain attachments.

Nginx must terminate TLS and proxy `/` to `127.0.0.1:3123`, `/ws/` to
`127.0.0.1:1999/` with WebSocket upgrade, and `/mcp` plus its subpaths to the
builder's existing MCP proxy route. Configure the public OAuth issuer/MCP URL
from `.env.example` for the actual domain. Do not proxy `/storage` to RustFS
in this R2 configuration.
