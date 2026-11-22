# Local delivery evidence — 2026-11-22

## Changes and review

- Saved the existing brand changes and Turbopack dev-cache fix in separate commits before merging latest main (`74325cd7b`) into dev.
- Resolved nine textual conflicts by combining Zalo group behavior and Inbox translation, CLI command names, and repository contracts.
- Fixed the new translation channel map's missing `zaloAccount`, preserving its previous 1000-character fallback. Added a boundary regression test.
- Reproduced and repaired translated group message text being hidden by the mention renderer. Group mention rendering remains unchanged without a translated main text.
- Reconciled migration snapshot prevIds with the repository tool. Generated a local snapshot to prove drift (duplicate translation/table-language/enum SQL), incorporated the merged DDL into the existing tip, and removed the generated directory. No migration.sql was added, changed or applied. The chain and drift gates pass.
- Added repository-scoped SHA image builds for all six actual runtime services. The reference's independent Zalo Personal application is intentionally absent.
- Added R2 ACL compatibility, a private-bucket public-prefix reader, browser CORS configuration, production Compose, environment template and host release script. Real local credentials/storage remain untouched.
- Applied the code-review skill's data safety/concurrency/security checks to the deployment failure paths. Separate invariant-guard reviews passed for merge resolution, translation fixes and uploader changes.

## Validation

- Frozen-lockfile installation passed.
- Root `pnpm lint` passed, including agent-instruction checks, invariants, i18n, schema drift and Ultracite.
- `pnpm check-types` passed: all 70 tasks successful. The final commit hooks also check the changed graph.
- Builder Inbox/translation/Zalo regression selection: 26 files, 309 tests passed.
- Total unique selected tests: 706 passed.
- Additional MessageItem attachment/group translation suite: 26 tests passed; translation component rerun also passed (46 total tests across that two-file run, including 20 already counted above).
- CLI command names: 46 tests passed.
- Database sharded message/group schema: 94 tests passed (no live database integration tests).
- Filesystem full suite: 51 tests passed.
- Business translation/message service selection: 104 tests passed.
- Zalo Account gateway full suite: 59 tests passed.
- Deployment/public-reader/production-validator tests: 17 passed, none skipped. Ubuntu script runs on macOS through small GNU command adapters; CI executes the same tests natively on Linux.
- Gateway bundle build and runtime dependency-import smoke check passed.
- `actionlint` passed for both workflows; `shellcheck` and Bash syntax passed for the host script.
- Production Compose interpolation and parsed environment validation passed with a temporary synthetic environment, without starting services or applying migrations.

## Limits and activation prerequisites

No push, live server deployment, real R2 provisioning/data copy, or database migration was performed. Full application Docker builds and a real Ubuntu rollout remain unverified; the local Docker test-container startup stalled and was cleaned up. No Docker backend or user-owned process was restarted. The tests validate host control flow with simulated Docker responses, not real container health or a restore drill. Coverage was not measured and the full monorepo test suite was not run.

Before live activation: configure production SSH/GHCR access, real host .env and R2 credentials/reader/CORS, preserve encryption keys and existing volume identities, copy/verify existing objects, approve the exact migration fingerprint, and complete first-install seed/backup restore preparation as applicable. See docs/deployment.md. Subsequent schema-unchanged dev pushes are unattended; a new unapproved migration is deliberately blocked by repository policy.
