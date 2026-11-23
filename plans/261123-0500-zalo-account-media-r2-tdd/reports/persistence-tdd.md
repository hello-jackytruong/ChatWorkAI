# Persistence and business delivery

Worktree: `/Users/jacky/.codex/worktrees/zalo-account-media-r2/ChatWorkAI`.

## Implemented

- Two main-store asset/reference tables; fixed storage/projection/deletion enums, owner slot identity, encrypted source separate from immutable private object keys, metadata provenance, reference alias and historical shard pointers, leased/candidate/deletion manifests and supporting indexes.
- Workspace child-write fence and account existence checks. Account closing has a durable sentinel; ordinary orphan cleanup affects only the admitted asset. Registration and deletion admission serialize under the same account lock. New references can create a next generation while an old asset is deleting.
- Durable idempotent registration, source ciphertext refresh, reference revision guards, scope predicates, CAS claims/completion/settlement, bounded due account fairness/aging, retry classification and Retry-After, safe source-missing behavior.
- Immutable original and separate preview registration in one completion transaction. Original/profile/sticker source identity is isolated correctly; sticker sharing is account-local. Actual sharded Attachment projection uses current parent/reference checks and origin-path CAS; projection failures keep bytes stored and remain retryable. Descriptor-only resources do not invent Attachment rows.
- Account/friend/group supplied avatar registration; unchanged source paths reuse identity and token changes update ciphertext. No absent avatar erases an archive; cover capture is conditional on an existing consumer.
- Scoped list/get/retry/download inputs and safe status mapping. Connected read/public API integration is owned by the capture agent.
- Bounded reference release, contact tombstone continuation, owner-aware orphan admission (first observation + 24h grace + independent zero-reference confirmation), workspace cleanup and manifest preservation.
- Bounded source-key rotation integrated into the existing encryption rotation CLI, with ciphertext compare-and-swap and no locator logging.

## TDD evidence

Observed RED before implementation:

1. Policy suite failed because the policy module did not exist.
2. Service suite exposed plaintext input leaking across the repository boundary and retry of a missing source; fixed and rerun GREEN.
3. Resource capture suite failed because its module did not exist.
4. Schema owner-slot uniqueness test failed before the slot was added to the unique index.
5. Rotation test failed because its helper did not exist.
6. Cross-message media identity test failed when provider ID incorrectly overrode message owner identity; fixed and rerun GREEN.
7. Retry-After/base-delay and empty-200 bounded-retry tests failed against the original backoff; fixed and rerun GREEN.

Repository tests use actual Drizzle SQL expression compilation with a controlled query client. They assert scope/state/token/expiry predicates, grace and generation admission, current owner aliases, manifest fencing, source ciphertext CAS, actual SQL column validity and bigint-to-text serialization. These are unit/query contract tests, not proof of live PostgreSQL concurrency or production query plans.

## Validation

Commands use `VITEST_MAX_WORKERS=1`; no coverage thresholds were disabled.

- Business focused policy/service/resource/projection suites: 31 tests passed on the final run; scoped V8 coverage 96.65% statements, 90.49% branches, 100% functions, 96.50% lines.
- Database focused schema/repository/persistence/rotation suites: 25 tests passed on the final run; scoped coverage 94.41% statements, 88.88% branches, 92.30% functions, 94.32% lines.
- Final SQL/reattach persistence file: 16 tests passed.
- Database `check-types` passed after schema and projection repository contract changes; root owns the final combined type/lint gates while concurrent integration completes.
- Targeted Ultracite formatting/checks run on owned implementation and tests; final root lint remains the combined delivery gate.

## Operational fence and limitations

A positive HEAD can prove usable immutable bytes for an active asset. It cannot prove that an older PUT has finished: an object from an earlier attempt may already exist while another PUT to the same key remains in flight. HEAD adoption therefore retains the old transport token and an unsettled remote marker. Current reads can use the verified bytes, but deletion remains blocked until the actual transport confirms settlement or operational quiescence is established. A missing/error HEAD never counts as absence or settlement. Unknown remote outcomes deliberately leave workspace purge incomplete with its manifest intact.

No live database, migration apply, provider, S3/R2, or production infrastructure operations were run. The controller generated and reviewed the additive migration. Live database concurrency/EXPLAIN, actual remote late-write/abort scenarios, private bucket preflight and provider fixture release gates remain staging verification work; this report does not claim those passed. No git staging, commits, pushes or merges were performed.
