# Red-team assumption audit

Scope: plan and phases 10–16 only. I did not run build, lint, typecheck, tests,
install, migration, or generator commands. Findings are based on the plan's
claims compared with the current repository boundaries.

## Findings

### 1. High — `Contact.kind` is not yet a complete customer-isolation boundary

The architecture assumes a discriminator can keep group anchors out of all
customer surfaces (`plans/261120-1602-zalo-account-group-inbox-and-operations/plan.md:37-46`),
and Phase 10 asks for central guards (`phase-10-full-group-inbox.md:38,48,61,83`).
The current access boundaries are not centralized enough for that assumption:

- The current Contact table has no discriminator at all (`packages/database/src/schema/contact.ts:36-77`).
- The list where-builder adds only `workspaceId` (`packages/database/src/repositories/contact/list-where.ts:46-50`), while the no-filter count takes a stats shortcut (`packages/business/src/contact/list.ts:307-336`).
- Export deliberately passes its caller's `where` through unchanged (`packages/database/src/repositories/contact/repository.ts:395-412`), and several public/detail/list repository methods also accept arbitrary `where` objects (`.../contact/repository.ts:132-177,227-256`).
- Reconciliation counts every Contact row for contact usage (`packages/business/src/workspace-usage/service.ts:139-146`), and owner quota reconciliation does the same (`packages/business/src/user-quota/service.ts:830-840`).

Adding `kind = person` to the normal list builder will therefore not protect
direct repository callers, export, the O(1) stats path, or quota reconciliation.
An anchor would inflate customer counts and may be exported even while the UI
list appears correct. The plan needs a mandatory person-only repository/service
boundary (including stats, export, filters, deletion/quota release, broadcasts,
and every direct caller), plus an explicit audit list before migration approval.

### 2. High — the existing Message/Conversation substrate is not side-effect-neutral, and its dedupe key is weaker than the group contract

The plan explicitly relies on the existing substrate while requiring “no
customer” effects (`phase-10-full-group-inbox.md:21-27,55-60`) and makes this a
load-bearing assumption (`plan.md:113-118`). The substrate carries customer
semantics at multiple boundaries:

- `ContactInbox.contactId` and `Conversation.contactId` are required Contact FKs (`packages/database/src/schema/contact-inbox.ts:103-113`, `packages/database/src/schema/conversation.ts:45-56`).
- The shared receive path extracts phone/email and updates/unblocks the Contact (`apps/worker/src/integration/handlers/received-message.ts:589-625`), awards the inbound leaderboard (`.../received-message.ts:702-709`), records inbound activity (`.../received-message.ts:1699-1716`), and emits the message event that drives triggers (`.../received-message.ts:1456-1495,1624-1627`). A group handler that reuses this path will violate the Phase 10 side-effect contract.
- Message dedupe is constrained by `(contactInboxId, sourceId, createdAt)` (`packages/database/src/schema/message.ts:63-94`); `createOrUpdate` only searches by source/conversation inside a 24-hour lookback (`packages/database/src/sharding/message/repository/sharded-message-repository.ts:1522-1534,2212-2245`). That does not itself guarantee the required account + group + provider-message identity across a longer reconnect overlap or timestamp variation.
- Phase 13 adds no-FK receipt/reaction tables (`phase-13-advanced-message-lifecycle.md:18-30`), but current no-FK purge registration is a fixed table registry (`packages/database/src/repositories/workspace-purge/tables.ts:82-140`) and Message/Attachment use a separate specialized purge (`packages/business/src/workspace-lifecycle/service.ts:489-520`). The plan does not name the new tables' account-inclusive uniqueness, retention, or message-delete/undo cleanup boundary.

The implementation needs a dedicated group persistence facade that calls only
side-effect-free Message/realtime primitives, a stable durable dedupe key/ledger
for `(workspace, account, group, providerMessageId)`, and explicit receipt/
reaction composite keys plus retention and purge/tombstone behavior. “Reuse
Message/Conversation/realtime” is not sufficient as an isolation design.

### 3. High — normalized group audience context will be lost or silently retargeted across automation boundaries

Phase 11 says to carry audience context into automation jobs and guard the
dispatcher once (`phase-11-group-controls.md:52-56`), but the current job and
scope contracts are contact-centric:

- Trigger jobs carry `workspaceId`, `contactId`, and an untyped metadata bag; there is no audience discriminator (`packages/worker-config/src/queues/trigger/index.ts:16-39`). The worker reconstructs only optional ContactInbox/Conversation IDs from that bag (`apps/worker/src/trigger/worker.ts:59-83`), and execution context has no group/account audience (`apps/worker/src/trigger/types.ts:46-81`).
- The action scope accepts an explicit conversation ID only for email threads; for every other channel it falls back to the Contact's latest conversation (`apps/worker/src/trigger/services/actions/scope.ts:64-79`). A delayed group trigger can consequently run against a newer thread or lose the group thread entirely.
- Flow continuations carry many optional fields but no typed audience (`packages/worker-config/src/queues/integration/index.ts:402-455`; continuation forwarding is manual at `apps/worker/src/integration/handlers/flow.ts:652-689`). The existing contract already documents context loss after Wait (`.../queues/integration/index.ts:450-455`).

This is a correctness and authorization boundary: a group event can resume as a
direct/customer action, or a customer action can be evaluated against the group
anchor after a fallback. Add a durable `person | zaloAccountGroup` audience
object (account/group/provider identity plus ContactInbox/Conversation IDs) to
TriggerJob, flow jobs, action scope, retries, wait/resume, and occurrence keys;
validate it before contact-run acquisition and return a structured skipped
result for disallowed actions.

### 4. High — label lock/grace/unknown-state guarantees are not represented by the current state machine

Phase 12 requires one per-account distributed lock, accepted-version/grace
state, and non-destructive handling of incomplete or unknown results
(`phase-12-native-labels-and-group-tags.md:21-27,51-57`). Current code does not
provide those guarantees:

- `sync` treats a non-empty snapshot as safe and enqueues deletion for every
  local mapping absent from it (`packages/business/src/zalo-account/label.service.ts:205-253`).
- `mutateAssignment` performs read/modify/write with a single conflict retry,
  has no account lock, and persists the local assignment immediately when the
  target is unchanged (`.../label.service.ts:265-333`).
- Transport state only rejects a numerically regressed version (`packages/business/src/zalo-account/transport.service.ts:499-512`); unknown/timeout results are merely thrown (`.../transport.service.ts:449-480`), with no durable pause or grace marker.
- The generic detach worker unlinks the local mapping even after a provider
  error/unknown outcome (`apps/worker/src/default/handlers/sync-tag.ts:363-387`).
- Group exclusion is inferred from a set of provider group IDs (`.../label.service.ts:218-231`) and direct Inbox lookups (`.../label.service.ts:46-69`), not from an anchor resource plus `Contact.kind` proof.

Without a durable completeness/degraded/grace state and an account-wide mutex,
concurrent sync and tag mutations can lose unrelated labels; a partial pull or
unknown write can detach local truth. The plan must specify the durable state
schema, lock key/lease behavior, provider-first local commit rule, and the
reconciliation path that preserves mappings on unknown outcomes.

### 5. High — friend sync cannot currently “reuse existing import/upsert rules” with the promised quota/MAC semantics

Phase 14 promises bounded idempotent `syncFriends` that creates only direct
`person` rows, counts quota, skips MAC, and is non-destructive on partial data
(`phase-14-public-api-cli-mcp.md:26-29,35-37,49-63`). The existing import paths
are materially different:

- The contact-sync identity resolver supports Messenger, Instagram, Zalo, and
  Telegram only; it has no `zaloAccount` resolver (`packages/business/src/contact-sync/profile-fields.ts:194-204`), even though the general ContactInbox normalizer does know the channel (`packages/business/src/contact/contact-inbox-identity.ts:63-73`). UID-only friend rows therefore need a new identity adapter, not a direct reuse.
- `importContactSyncPage` creates/resolves rows in a transaction, then increments
  authoritative quota and workspace usage afterward (`packages/business/src/contact-sync/import-page.ts:178-194,352-368`). A crash between those steps leaves rows present but quota uncounted; a replay sees existing rows and cannot infer the missing increment.
- The bulk import path creates Contact + ContactInbox + Conversation (`packages/business/src/contact/bulk-import-channel-contacts.ts:34-43`) and emits customer-created/analytics events (`.../bulk-import-channel-contacts.ts:138-175`), while only incrementing workspace usage (`.../bulk-import-channel-contacts.ts:178-190`). The no-MAC helper has yet another contract: it increments the authoritative `contacts` metric after its transaction but does not create MAC activity (`packages/business/src/quota-enforcement/service.ts:560-595`).

The plan must choose and adapt one path: define the `zaloAccount` source/
identity and event policy, make quota accounting crash-recoverable and
idempotent (outbox or durable created-row ledger), and prove that retries,
partial pages, and MAC reconciliation cannot undercount or double-count. “Use
existing import/quota accounting” is not an executable boundary as written.
