# Durable canonical reconciliation implementation

Date: 2026-11-23. Worktree: `/Users/jacky/.codex/worktrees/zalo-account-integrity/ChatWorkAI`.

## Delivered

- Atomic locked ACK settlement returns the durable winner. Equal ordered/deduplicated IDs are idempotent; a different ACK preserves original primary/aliases and changes local state to `needs_review`, invalidating stale revisions. Late failures cannot downgrade accepted delivery.
- Nullable reconciliation JSON and an applied/pending due-work partial index. Confirmed IDs and observed client IDs are exact, scoped and bounded to ten each. Unknown outcomes remain non-replayable.
- Existing canonical service exposes `reconcileMessage`, `getOutcomeByMessage`, and `recoverReconciliation`. The send-attempt service exposes exact-match `resolveOwnEcho`. Public projections hide CAS revision, while internal Message evidence carries a revision for concurrency protection.
- Opt-in aliases preserve the original primary and use sorted source locks. Same-store echo cleanup reparents attachments and replies before deleting duplicate Messages. Translation-bearing echoes, excessive row counts, missing proof, and distinct historical/current stores retain data for review. Shared callers without aliases keep their old path.
- Group identity rebinding changes only the canonical address; published timestamps remain and published payload stays null. The alias merge preserves nested account/group/send-attempt metadata. Lifecycle operations resolve secondary confirmed IDs to primary source identity.
- Local recovery uses the existing scheduler/lock, owner guard, at most twenty claims per pass, and three automatic attempts; null legacy JSON is excluded. Claims and completion use monotonic revisions and confirmed-ID CAS. Crash after the third claim becomes review instead of endless retry.
- Message evidence uses a targeted atomic repository update with an existing-revision guard and a fresh JSON merge. Completion increments the revision. Scoped existing `messageContentUpdated`, `messageIdAssigned`, and `messageRemoved` events update Inbox clients. Failure/unknown/cached outcomes project sanitized metadata.

## RED evidence

Before source changes, business send-attempt tests had two real failures: a transport result returned `["loser"]` despite atomic settlement returning `["winner"]`; an empty provider ACK ID incorrectly resolved. Seven pre-existing tests passed.

Before the alias implementation, the over-budget alias test entered the legacy write-shard transaction and threw `Cannot read properties of undefined (reading 'transaction')`, demonstrating that aliases had no validation/opt-in path.

## GREEN evidence

All focused commands use `VITEST_MAX_WORKERS=1`.

- Business Message service + send attempt + canonical send + lifecycle + group Inbox: 45 passing tests; final focused run after the guarded-evidence changes passed.
- Database sharded Message repository + alias reconciliation + ACK/CAS tests: 99 passing tests before addition of the extra atomic evidence SQL test. Latest alias/ACK suites: nine passing tests.
- Existing worker group recovery: one passing test.
- Real DB interleaving suite is present at `packages/database/__tests__/integration/zalo-account-send-reconciliation.test.ts`: skipped under the non-routable test sentinel. It covers a second-client row-lock barrier, conflicting ACK winner, stale repair CAS, and exact account/thread alias scope. No real database proof is claimed.
- Focused Ultracite fixes/checks were run on owned files; broad lint/types are coordinated by the controller. `git diff --check` passed.
- Generated migration `packages/database/drizzle/20261123081808_zalo_account_local_reconciliation/migration.sql` was inspected: only one nullable JSONB column and the partial due-work index. `db:check-drift` passed. No `.env` file was loaded, migration was never applied, and no account/provider was called.

## Deliberate safety limits

The five-second recovery limit is an admission/scheduling budget checked between rows, not a hard wall-clock cancellation deadline. New ACK/claim/merge transactions have a 500 ms lock timeout and one-second statement timeout; existing account reads, registry reads and bounded snapshot probes can still extend a slow individual iteration. No abandoned background promise is used to pretend that work was cancelled.

Cross-physical-store or translated echoes are retained for explicit review; this change does not silently perform an unsafe distributed delete. Same-store merges retain attachments and reply references, with a bounded preflight. Concurrent realtime enqueue ordering additionally requires the controller's client-side revision guard.

No migration application, live account test, global typecheck, broad build, commit, push, or merge was performed by this implementation delegate.
