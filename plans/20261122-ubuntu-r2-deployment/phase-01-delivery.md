# Delivery

1. Inspect and commit brand assets/cache fix; merge origin/main.
2. Compare reference workflow, production script, backups/migrations/rollback and service ownership against current Dockerfiles.
3. Add production Compose (R2, no RustFS), gateway image, workflow and host deploy script.
4. Preserve ACL behavior on S3/RustFS while removing unsupported ACL headers for R2; test real command construction.
5. Add public-prefix-only R2 reader, configuration template and Ubuntu runbook.
6. Run script/workflow/config validation, lint, types and relevant regression tests. Review deployment failure paths.

Risks: R2 credentials/Ubuntu target may be unavailable; do not claim a live rollout. Migrations require explicit approval and cannot be reversed by image rollback. Existing volume names and object keys must be retained when migrating an existing installation.

Rollback: keep release configurations and current/previous pointers; restore previous application images, never drop data volumes or automatically restore the DB.
