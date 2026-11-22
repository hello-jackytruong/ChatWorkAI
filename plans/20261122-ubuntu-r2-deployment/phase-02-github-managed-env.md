# GitHub-managed host bootstrap

Status: implemented locally; live SSH activation not run.

Outcome: GitHub Secrets owns the complete production dotenv. A workflow run creates the server folder, installs small missing bootstrap tools, clones/fetches the exact tested source, authenticates to GHCR temporarily, installs the new env, starts/checks apps and recovers the previous env on activation failure. The server's prerequisites are Docker/Compose, Nginx and an SSH account with the necessary permissions.

Constraints: no credential values in Git/logs/artifacts/cache or command arguments; keep DB data and encryption identity; preserve migration approval policy; do not run live migrations during local testing.

Changed surfaces: production workflow and CI syntax checks; bootstrap.sh; production.sh; compare-production.py; bootstrap/host regression tests; production env template; deployment runbook.

Acceptance: real local Git clone/fetch fixture passes; secret receiver cleanup on success/failure passes; same-commit env reruns have distinct deployment IDs; rollback selects previous env; unsupported DB/encryption/volume changes are rejected before activation; first-install seed only runs with explicit GitHub env approval; existing regression and lint gates pass.

Rollback: previous release env and local images remain available; current/env pointers only advance after health checks. No automatic DB restore or volume removal. Legacy SHA-only release layouts remain readable.

Verification: [GitHub-managed env report](reports/github-managed-env-verification.md).
