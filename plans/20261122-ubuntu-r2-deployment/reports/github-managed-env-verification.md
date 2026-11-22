# GitHub-managed env and host bootstrap verification

Date: 2026-11-22. Scope: local implementation only; no secrets uploaded, remote push, live SSH operation, seed, migration or server activation performed.

## Delivered behavior

- GitHub production secret `PROD_ENV_FILE` owns the full dotenv. Verified SSH stdin transports the dotenv and job-scoped token without artifacts/cache/secret-bearing command arguments.
- First run creates the deployment folder, installs missing Git/Python/util-linux tools, clones the repository and checks out the tested SHA. Later runs fetch that SHA and refuse dirty/wrong-repository checkouts.
- Full source stays in `repo/`; small versioned runtime deployment directories contain Compose/scripts/0600 dotenv and image metadata.
- Built-in GITHUB_TOKEN provides temporary Git/GHCR authentication; no PAT or manual host registry login is needed for repository-linked packages. Askpass/token/Docker config live only in the receiver's private session directory and are deleted on exit.
- Unique SHA/run/attempt IDs preserve env snapshots across same-commit reruns. Activation failures restore old images and old env; active env pointers advance only after successful service checks.
- Ordinary env changes are automatic; DB credentials/identity, data volumes and encryption-key changes fail before cutover. Stale SSH-account application exports cannot override the GitHub dotenv when Compose runs.
- Exact SQL fingerprint approval remains in the GitHub dotenv under repository migration policy. Explicit first-install seed approval is also configured there; existing upgrades never reseed.

## Evidence

- `node --test scripts/deployment/*.test.mjs deploy/r2/*.test.mjs`: 33 passed, zero skipped.
- Real local Git fixture clones, fetches a second commit, verifies source/env files and mode 0600, checks inherited deployment-lock FD, rejects dirty checkouts and confirms token values are absent from Git config.
- The exact workflow receiver is tested with tar stdin and both successful/error child exits, confirming private session cleanup.
- Host-script tests cover same-commit env updates, previous-env recovery, stale host-env exclusion, approval/backup/image/migration failures, fresh seed and seed failure.
- Actual Python transition validator tests reject every protected DB/encryption/volume change and accept ordinary app env changes without printing their values.
- `pnpm lint`, Bash syntax, ShellCheck and actionlint passed. No TypeScript application/package contract changed, so no new workspace type-check or app test rerun was needed for this follow-up.

## Limits

Docker operations inside control-flow tests are simulated; real remote authentication, package provisioning, GitHub GHCR permissions and service health must be verified during the first deployment. Server prerequisites remain Docker/Compose, configured Nginx, verified SSH access and sufficient account permissions (root or passwordless sudo for first-run bootstrap where needed). Real production values must be configured in GitHub before running the workflow. The operational guide is docs/deployment.md; it supersedes the earlier manual-host-env setup.
