# Chatwork AI: Ubuntu + Cloudflare R2

Production releases come from **dev** via `.github/workflows/deploy-production.yml`.
The workflow reuses the full CI gate, builds six application images on GitHub,
then transfers a small release bundle to Ubuntu. The server only pulls images;
it never builds source. There is no push/deploy performed by local validation.

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

## One-time Ubuntu preparation

Use Ubuntu with Docker Engine, Compose v2.24+ (or v5), Python 3, Bash, `flock`,
and host Nginx. Plan at least 8 GB RAM and enough disk for database, backups,
current and previous images. Database/Redis have no public ports. Only Nginx
should be internet-facing (80/443); app ports bind to loopback. The executor
uses a private internal network; only the worker can access it.

```bash
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /opt/chatworkai
# Copy scripts/deployment/production.env.example to /opt/chatworkai/.env
chmod 600 /opt/chatworkai/.env
```

Fill the env template with real secrets and **retain existing integration,
mail, edition and Zalo transport settings** from the current `.env`. The
example is deployment-specific, not a replacement for all optional settings in
`.env.example`. Generate separate random secrets; `ENCRYPTION_KEY` is 32 random
bytes encoded as 64 hex characters. Preserve the existing encryption key and
auth secrets when upgrading. URI-encode the password in `DATABASE_URL`.

If adopting an existing installation, inventory containers and volumes first.
Set `POSTGRES_VOLUME_NAME` and `REDIS_VOLUME_NAME` to the actual existing names.
Do not start a second Postgres against a live volume. Stop the old datastore
containers during the planned one-time adoption, retaining volumes and backups.
Match the existing Postgres/Timescale major and extension version before
adoption; this Compose file follows the repository's existing PG18 image.
Normal deploys use `--no-recreate` for datastores and never pull/upgrade them.
Pin the verified datastore image digest before a separate database upgrade.

Install the dedicated Actions SSH public key in the deploy user's
`authorized_keys`. Docker group membership is effectively root access; use a
dedicated deploy account. Log that account into GHCR with a read-packages token
via `docker login ghcr.io --password-stdin` if images are private. Pin the host
key verified via an independent trusted route; do not blindly trust ssh-keyscan.

In GitHub environment **production**, configure secrets `PROD_HOST`,
`PROD_USER`, `PROD_PORT` (default 22), `PROD_SSH_KEY`, and
`PROD_SSH_KNOWN_HOSTS`. Optional environment variable `PROD_DEPLOY_ROOT`
defaults to `/opt/chatworkai`. No required reviewers on this environment if
unattended releases are desired. Secrets stay on the host; they are never
passed as Docker build arguments or bundled in release artifacts.

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

## Deployment, migration approvals and recovery

After setup, a dev push automatically runs CI, builds/pushes SHA images and
activates the release. No source checkout or Git credentials are needed on the
host. The workflow serializes the entire pipeline, and the host has separate
activation/data-operation locks. Failed pull, revision mismatch, invalid env
or unapproved migration stops before application replacement. Backups use
`pg_dump -Fc` and `pg_restore --list`; archive validation is not a restore drill.

The repository requires explicit approval before applying migrations. Review
pending SQL, compute `node scripts/deployment/migration-digest.mjs`, and set
`APPROVED_MIGRATION_DIGEST` in the host env to that exact fingerprint. This is
also required for first deployment. An unchanged migration fingerprint needs
no further approval and releases are unattended. An unapproved schema change
fails safely; do not treat this as a fully automatic migration approval. Review
backward compatibility before approving: image rollback does not undo schema
changes. First-install seed is a separate, explicitly approved operation using
the builder image's `seed` command after migration (see the existing root
README and database seed documentation); normal releases never reseed data.

A deploy starts/reuses datastores, creates and verifies a DB backup, runs
approved migrations, then starts executor, builder, realtime, MCP, gateway and
worker with readiness waits. If activation fails, it attempts all previous app
images; on first-release failure it stops the partial app set. Running worker
checks establish process liveness, not successful queue throughput; verify a
real inbound/outbound message and queue progression as the initial smoke test.

State is in `/opt/chatworkai/current`, `/opt/chatworkai/previous`, and
`state/migrations.sha256`. Failed activations return nonzero to Actions;
detailed logs are retained in `logs/deploy-<sha>.log` with private permissions.

```bash
# Use the host script from the current release.
cd /opt/chatworkai
./current/scripts/deployment/production.sh check
./current/scripts/deployment/production.sh backup
./current/scripts/deployment/production.sh rollback
```

Keep current/previous release bundles and image tags. The script never runs
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
