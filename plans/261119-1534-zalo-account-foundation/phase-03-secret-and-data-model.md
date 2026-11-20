---
title: "Phase 3: Secret and data model"
status: todo
---

# Phase 3: Secret and data model

## Outcome

Add the smallest durable model for an authorized personal Zalo account and make
the existing channel store-binding path capable of encrypted auth. Do not add
group/thread/tag/sync-cursor tables before those behaviors have contracts.

## Data ownership

`Connection` remains authoritative for connected/disconnected/reauth state.
`IntegrationZaloAccount` owns only provider identity/profile plus encrypted
session authorization:

- `id`, `workspaceId`, `inboxId`
- `zaloUid`, `name`, optional `avatarUrl`
- `encryptedAuth`
- `sessionVerifiedAt`
- shared timestamps

No raw `cookie`, `imei`, or `userAgent` column is allowed. No duplicate runtime
status is stored on this table.

## Requirements

- [x] Unique `inboxId` and unique `(workspaceId, zaloUid)`; every repository
  predicate includes `workspaceId`.
- [x] `workspaceId` and other purge-driving FKs are indexed; workspace/inbox
  deletes cascade safely.
- [x] Auth encrypt/decrypt uses the shared encryption package and AAD bound to
  `workspaceId`, provider, and `inboxId`.
- [x] Generic channel binding supports an explicit encrypted auth column/codec
  without changing existing plain-auth channel behavior.
- [x] Reads returned to app/API code never include `encryptedAuth` unless an
  internal business method explicitly requests and decrypts it.
- [x] Reconnect load validates the canonical Phase-1 auth schema and rejects
  corrupt ciphertext or mismatched AAD.
- [x] Migration is generated and inspected, never applied in this task.

## Files

### Create

- `packages/database/src/schema/integration-zalo-account.ts`
- `packages/database/src/relations/integration-zalo-account.ts`
- `packages/database/src/repositories/integration-zalo-account/repository.ts`
- `packages/database/src/repositories/integration-zalo-account/index.ts`
- `packages/business/src/zalo-account/auth.ts`
- `packages/business/src/zalo-account/service.ts`
- `packages/business/src/zalo-account/index.ts`
- `packages/business/__tests__/zalo-account.service.test.ts`
- `packages/database/__tests__/integration/zalo-account.test.ts`
- generated migration and Drizzle snapshot files

### Modify

- `packages/database/src/schema/index.ts` — export schema.
- `packages/database/src/relations/index.ts` — import **and** spread relations.
- `packages/database/src/relations/inbox.ts` and `workspace.ts` — reverse relations.
- `packages/database/src/repositories/index.ts` — repository export.
- `packages/database/src/types.ts` — export a public model that omits
  `encryptedAuth`; keep any full-row type internal to the repository/auth codec.
- `packages/business/src/index.ts` — service export.
- `packages/business/src/connection/store-bindings.ts` — encrypted channel auth codec.
- `packages/business/src/connection/store-bindings-channels.ts` — binding entry
  only after the schema and codec tests pass; it remains unreachable while the
  provider registry entry is `null`.
- `packages/business/src/connection/__tests__/store-bindings.test.ts` — codec regressions.
- workspace purge/schema parity tests required by repository invariants.

## Tests Before

1. Add failing schema integration tests for FK cascade, unique inbox, unique
   workspace/account identity, cross-workspace allowance, and indexed purge path.
2. Add failing store-binding tests for encrypted insert/load/save, wrong
   workspace, wrong AAD, malformed decrypted payload, and unchanged plain-auth bindings.
3. Add service tests that public metadata excludes ciphertext and only the
   internal reconnect method can return decrypted validated auth.
4. Add a secret-projection regression test that serializing public account
   metadata cannot reveal cookie/IMEI/user-agent/ciphertext.
5. Add migration drift/default parity checks before generating SQL.

## Implementation Steps

1. Define the table with explicit FK actions and indexes. Use a composite
   workspace identity constraint; do not impose an undocumented global account lock.
2. Wire schema export, both relation-index edits, reverse relations, model type,
   and repository export in the same change.
3. Add repository methods with mandatory workspace scope: find by inbox,
   find by UID, insert, update encrypted auth/profile, and delete.
4. Add provider auth codec using shared encryption and canonical SDK schema.
   Encrypt before opening a DB transaction.
5. Extend `makeChannelBinding` with an optional auth-column/codec contract
   equivalent to the existing workspace-integration codec. Default behavior
   must remain the current plain `auth` column.
6. Add the Zalo Account binding with `encryptedAuth`, `zaloUid` identity, and
   `keep_row` for passive reconnect. Later manual disconnect behavior must be
   controlled by `Connection.statusReason`, not by gateway guesswork.
7. Generate the migration with the repository command, inspect SQL for table,
   constraints, indexes, and cascades, then stop. Do not run `db:migrate`.

## Refactor

- Share the channel auth-codec plumbing only; do not replace existing provider
  schemas or bulk-convert their auth columns.
- Keep business orchestration in `packages/business`; the gateway will call it
  and must not import `db` or a repository directly.

## Tests After

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account.service.test.ts src/connection/__tests__/store-bindings.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database test:db -- zalo-account.test.ts
pnpm --filter @chatbotx.io/database db:check-drift
pnpm --filter @chatbotx.io/database check-types
pnpm --filter @chatbotx.io/business check-types
```

Run DB-backed tests only against the explicit test database configuration. Do
not translate this test command into approval to migrate any real environment.

## Acceptance Criteria

- [x] Database never stores Zalo personal session credentials in plaintext.
- [x] Cross-workspace reads/writes and AAD swaps fail closed.
- [x] Existing channel store bindings behave exactly as before.
- [x] Workspace/inbox deletion removes the row through bounded indexed cascades.
- [x] Migration and snapshot agree with schema and remain unapplied.

## Risks and rollback

- Risk: generic binding change affects every channel. Keep the codec optional,
  default to current behavior, and run the full business connection suite.
- Risk: ciphertext becomes undecryptable after key/AAD changes. Pin the AAD
  format in tests and use the shared encryption key-rotation behavior.
- Rollback: disable the unreachable binding/service first. Preserve the table
  until encrypted-data retention is explicitly decided; never auto-drop it.
