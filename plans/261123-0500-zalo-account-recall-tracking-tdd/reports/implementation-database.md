# Database implementation

2026-11-23. Worktree: `/Users/jacky/.codex/worktrees/zalo-account-recall-tracking/ChatWorkAI`.

## Delivered

- Two additive main-DB metadata tables: `ZaloAccountMessageRecall` and `ZaloAccountNativeOperationAttempt`; no original content copies, no Message shard migration, existing group identity/send-attempt schemas unchanged.
- Recall natural key, nullable stable pointer pair check, independent recall/local-hide/provider-delete state, revision CAS, applied/published recovery, bounded cursor, indexed purge/FK coverage and relation import/spread registration.
- Native durable pending→dispatched first-winner CAS, immutable fence and target refs, request-hash conflict protection, transaction passthrough for atomic outcome+lifecycle writes. No Redis TTL dependency.
- Exact sharded lifecycle update guards workspace/conversation/ContactInbox/source/id/time, atomically merges nested JSON, retains original text/attachments and does not cascade replies. Shared generic delete untouched.
- Historical primary locator visits at most two ranges per call, returns cursor when unresolved, fails loudly on primary outage, has no 90-day cutoff. Stable placeholder original fill is one-time and keeps lifecycle metadata.
- Group persistence retains late originals, shares target lock, reuses recall pointer/identity, fills existing placeholder, returns `recalled` and updated lifecycle marker. Tracking retains late receipt/reaction writes under same scoped target lock; existing 90-day purge unchanged.

## TDD evidence

All focused commands use `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run ...`.

- `__tests__/zalo-account-lifecycle-schema.test.ts`: RED 1 failure / 2 pass (“durable recall ledger” missing); GREEN 3 pass after both schemas.
- `__tests__/sharded-message-repository.test.ts`: RED 2 failure / 90 pass (exact lifecycle operation absent); GREEN 92 pass after exact mutation. Added post-implementation historical cursor/outage tests: GREEN 94 pass. Existing shared-delete characterization stays green.
- `__tests__/zalo-account-state-undo-order.test.ts`: RED false result after recall; GREEN late receipt retained under serialized target lock.
- Post-implementation repository tests: `zalo-account-native-operation-attempt.test.ts` 2 pass (durable dispatch CAS; caller transaction); `zalo-account-message-recall-repository.test.ts` 4 pass (full lock key, duplicate provenance, revision CAS, immutable pointer).
- Schema/group/purge/FK plus exact/tracking/native combined: 7 files / 124 pass before adding recall repo 4 + locator 2; final focused expected total 8 files / 130.
- Targeted Ultracite fixes applied. `git diff --check -- packages/database` passed. `db:check-drift` passed after migration generation and tuple type annotation correction.
- Parent initial DB typecheck found pgEnum tuple overload errors; corrected to explicit nonempty tuples. Final typecheck recorded below when complete.

## Migration and limits

Generated through `pnpm --filter @chatbotx.io/database make:migration add_zalo_account_recall_tracking`; inspected `packages/database/drizzle/20261123081746_add_zalo_account_recall_tracking/migration.sql`: only two enums, two new tables, checks, indexes and FK constraints. **Not applied**. No secrets accessed/copied/printed. Nullable anchor FKs use SET NULL plus partial leading indexes; heavy tables registered before parent drains.

Database-backed tests, EXPLAIN/RI lock measurements and concurrent real DB/provider proof were not run because migration application requires separate explicit approval. Unit query/CAS tests do not prove provider behavior. Full repository lint/coverage and sequential integration typechecks remain controller-owned gates. No commits.

Final database results: `pnpm --filter @chatbotx.io/database check-types` PASS (exit 0); final focused eight-file run **130/130 PASS**; targeted `ultracite check` over 19 touched source/test files PASS. No background process remains from this slice.

## Post-review historical-original correction

A review found that original fill only wrote the current workspace shard, then returned an unchanged historical placeholder as if it were a saved original. Added two regression tests first: RED 2 fail / 94 pass. Exact fill now attempts the timestamp's historical primary ranges after the active write primary misses, propagates historical primary errors, and rejects a still-placeholder fallback. Already committed non-placeholder originals remain idempotent after exact contact/source validation. The group caller throws on a missing fill instead of falling through stable-create with an existing empty placeholder. Added primary-outage regression: final sharded suite **97 PASS**. Scoped formatter applied; no schema/migration changes or migration execution, no tsc started during another agent's slot.

Follow-up safety guard: a primary `findById` fallback may locate an exceptionally backdated row on a historical shard outside its exact registered timestamp range. That lookup is not proof that the mutation applied. Added a regression RED (1 fail / 97 skipped), then required matching recall identity, equal/newer lifecycle revision and all requested monotone state before acknowledging fallback success. These exceptional out-of-range backdated writes remain unavailable/pending rather than falsely acknowledged; widening shard routing/fan-out is outside this narrow correction. No quiet success on a stale marker.

## Delayed placeholder across two shard rotations

Confirmed another lifecycle-specific routing gap using a stateful three-primary fake and the actual stable-create/fill/find-by-id methods (no repository method spy): recall observed in range A, delayed placeholder creation during active range B, then rotation to C. Previously the tuple retained A's timestamp but generic stable creation physically inserted into B. Two later fill retries each returned unresolved because exact A+C updates never touched B. RED: 1 fail / 98 skipped; failed outcomes `[undefined, undefined]` instead of the late original twice.

Authorized narrow correction: scoped Zalo stable creation selects one registered primary covering the reserved `createdAt`, using existing workspace hashing across covering physical ranges. A private client passthrough supplies only that selected primary to the existing transaction/insert core. Other stable creation and generic message creation still use the current write primary. No full-history write fan-out, schema hint, migration or new queue. Missing covering range or unavailable primary throws, preserving pending repair.

The two-rotation test now creates in A, then fills and retries correctly after C is active. Added non-Zalo backdated/current-primary characterization, missing-range and primary-outage cases. Full focused sharded repository suite: **102 PASS**, scoped formatter PASS. Existing exceptional rows already created outside their registered physical ranges remain honestly pending/unavailable; this correction prevents new scoped Zalo stable placeholders from creating that condition. Database types rerun separately under the controller's exclusive slot.

Post-routing `pnpm --filter @chatbotx.io/database check-types`: PASS (exit 0). Scoped Ultracite and whitespace diff checks: PASS. Exclusive types slot released; no background process remains.
