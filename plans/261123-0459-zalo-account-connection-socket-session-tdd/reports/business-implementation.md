# Business and database implementation evidence

Date: 2026-11-23. Scope: approved Zalo Account P0.1 business/status and existing JSON persistence. No migration, commit, push or deployment performed.

## Behavior and focused review

- Ownership claims and auth refresh retain existing row-lock/purge guards, immutable identity checks, ciphertext fingerprint CAS and current Redis ownership validation. Hold survives refresh via the latest private source/current ciphertext lineage; generic QR replacement remains distinct.
- Lifecycle and diagnostics retain separate durable orders. Diagnostic writes preserve groups/friends/labels and never transition Connection or quota. Existing lifecycle transitions return acceptance after commit; inactive and mismatched connections do not produce accepted updates.
- Status performs one targeted account read, one targeted Connection read and one two-key Redis MGET. There is no provider request, decryption, scan or group list. Full fence/epoch/attempt/sequence matching is required for a verified socket sample. Missing, malformed, mismatched or expired samples cannot prove an open socket. Redis failure preserves safe durable context and returns unknown freshness. An old SDK last-event timestamp does not close a socket with a fresh sample.
- Public account resources now explicitly select existing metadata fields and groups/friends/labels operation siblings, excluding runtime diagnostics and arbitrary future row fields. Runtime status uses SDK whitelist schemas; private hold/fence/owner/auth material does not escape.

## TDD evidence and real database gate

- New resource projection regression first failed: the old row spread exposed an unknown private field. Explicit field selection fixed the failure.
- New real PostgreSQL regression first failed: lifecycle sequence4 applied against durable diagnostic sequence5 within the same fence/epoch/attempt. Added a lower-sequence guard; equal sequence remains admissible for independent legacy/diagnostic order and no-metadata legacy ordering remains compatible.
- Final focused business run: **2 files, 38 tests passed** (28 account/status tests and10 runtime-state tests), 0 skipped. Includes complete order mismatch matrix, old-row null runtime, Redis failure, stale/malformed/missing snapshot, silence, resource budget, scope/redaction, rejected stale state and transaction acceptance timing.
- Final PostgreSQL run: **1 file, 11 tests executed and passed, 0 skipped**, Vitest reported no type errors. Uses two actual PostgreSQL connections and deterministic `pg_blocking_pids` barriers. Covers duplicate effects once, lower fence behind claim, lower sequence, both same-UID QR/refresh commit orders, hold/replacement, rollback, three inactive statuses and mismatched workspace/inbox/UID. Fixture user/workspace/inbox/connection/account are unique; scoped cleanup deletes fixture workspace/user and closes clients. No schema migration was applied.
- Commands:
  - `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account.service.test.ts __tests__/zalo-account-runtime-state.test.ts`
  - `VITEST_MAX_WORKERS=1 ZALO_ACCOUNT_DB_TESTS=1 DATABASE_DEBUG=false pnpm --filter @chatbotx.io/database exec dotenv -e ../../.env -- vitest run __tests__/integration/zalo-account-runtime-state.test.ts`
- Final targeted Biome check: **8 files passed**, no remaining fixes/errors. Initial new test formatting warning was corrected.

## Remaining integration gates

Root session owns final sequential package typechecks, full lint, broader regression and coverage. These were not independently run by this agent. Live Zalo/provider behavior is not claimed by these fixture-based tests.

## Controller final follow-up

The explicit resource whitelist needs `operations:null` for a DB row without operations to satisfy the existing public model type. Controller repaired that nullable branch; the fixture/expected projection now include actual nullable operations and group policy defaults. Focused38 tests pass after repair. Full business suite rerun confirms **675files/10820tests passed**,52files/552opt-in tests skipped,exit0. All dependent types and final root lint pass. Full coverage gate is tracked separately and remains unresolved, not inferred from the plain suite.
