# Red-team assumptions and contract review (items 5–9)

Scope: plan/phase review only. I read the requested plan, phase files, scout/provider reports, Zalo Account documentation, and the relevant current contracts. No product code was changed and no install, build, typecheck, test, or lint command was run.

## Overall assessment

The boundaries are mostly correct: the gateway is the only `zca-js` owner, direct messages should use the existing worker pipeline, and groups must not be silently converted into 1:1 Inbox traffic. The plan is not implementation-safe yet because several statements are architectural intentions rather than executable contracts. The highest-risk gaps are command fan-out, route-key scoping, atomic fencing, QR trusted completion, and the `connect_session`→`account` ownership handoff.

## Verified assumptions

- `zca-js` 2.1.2 exposes separate user/group thread types, both `msgId` and `cliMsgId`, and self-echo fields; the static provider report records those shapes but explicitly says there was no live account (`reports/zalocrm-reference.md:9-27`, `:115-135`).
- The existing gateway is intentionally transport-incomplete: the event sink is a no-op (`apps/zalo-account-gateway/src/main.ts:15-19`), and runtime commands contain only `workspaceId` and `runtime` (`apps/zalo-account-gateway/src/runtime/ports.ts:63-75`). Phase 5 must therefore define the complete command/event wire contract rather than merely adapt an existing one.
- The current lease store atomically acquires, renews, and releases a lease, but has no fence-assert-and-append operation (`apps/zalo-account-gateway/src/runtime/account-lease-store.ts:12-31`, `:43-86`). The plan's compare-and-`XADD` requirement is necessary, not an already-proven capability.
- `ChannelType` is intentionally exhaustive and documents the required cascade (`packages/utils/src/channel.ts:15-16`, `:121-209`). `zaloAccount` is absent today; the channel registry and integration lookup registry also omit it (`packages/channel-registry/src/registry.ts:55-103`, `:161-240`).
- The existing message persistence deduplicates by `sourceId` only within a conversation/workspace and a bounded 24-hour lookback (`packages/database/src/sharding/message/repository/sharded-message-repository.ts:89-93`, `:1420-1469`, `:2110-2165`). It is not a durable account/thread-type/provider-event ledger.
- Native labels are statically a whole-document `{labelData, version}` API, and the reference observes a 1–3 second read lag after writes (`reports/zalocrm-reference.md:394-423`). This proves the shape for the pinned package, not live personal-account behavior or a provider compare-and-set guarantee.
- The migration gate is explicit in the foundation: SQL was generated/inspected and must remain unapplied pending approval (`plans/261119-1534-zalo-account-foundation/plan.md:54-63`, `:133-146`; `packages/database/drizzle/20261119161633_zalo-account/migration.sql:1-18`).

## Findings

### Critical

#### C1 — “Broadcast to active gateway replicas” is not the existing Redis Streams semantic

Phase 5 says every active gateway replica may observe an untargeted command (`phase-05-fenced-gateway-transport.md:18-24`) and proposes dedicated Redis streams/consumer groups (`:46-51`). `BaseEventBus` uses `XREADGROUP` with one consumer group (`packages/event-bus/src/event-bus.ts:196-226`), so consumers in the same group divide entries; they do not all observe each command. `cloneForGroup` creates a *different* group (`:233-238`), while entries are retained precisely so multiple groups can read them (`:221-230`).

Without an explicit fan-out design, a start command will reach one gateway replica, not all active replicas. If per-replica groups are chosen, replica-group creation, consumer deregistration, retention, and duplicate execution/lease races must be specified. Pub/Sub would provide fan-out but not the plan's durable replay/reclaim behavior.

**Minimal amendment (item 5):** freeze one of these contracts in the phase: (a) one durable command stream plus one consumer group per gateway replica, with a deterministic replica-group lifecycle and bounded retention, or (b) a durable per-replica command stream populated by a fan-out publisher. State that a normal shared consumer group is *not* broadcast. Add a test proving two replicas both observe an untargeted command while only one lease winner starts the socket.

#### C2 — The route key can cross-route or fail closed incorrectly unless workspace/account scope is part of the worker contract

Phase 7 requires `IntegrationZaloAccount.id` paired with workspace/Inbox and says `zaloUid` is not an unscoped lookup (`phase-07-direct-messaging.md:25-31`). The current integration job shape, however, contains only `integrationType`, `integrationIdentifier`, and `payload` (`packages/worker-config/src/queues/integration/index.ts:132-150`). The generic identifier lookup is an unscoped `SELECT ... LIMIT 1` (`packages/database/src/repositories/integration-lookup/repository.ts:24-33`), and the generic registry has no `zaloAccount` branch (`packages/channel-registry/src/registry.ts:161-240`). The existing table only guarantees `(workspaceId, zaloUid)` uniqueness, not global UID uniqueness (`packages/database/src/schema/integration-zalo-account.ts:35-47`).

Therefore “account ID paired with workspace/Inbox” is not an executable route key until the job/envelope and specialized resolver are changed. Using `zaloUid` alone can select the wrong workspace; putting scope only inside an opaque payload also defeats `resolveWorkspaceId`, whose integration fallback calls the same generic lookup and fail-opens when it cannot attribute a workspace (`apps/worker/src/lib/resolve-workspace-id.ts:103-137`).

**Minimal amendment (items 5–7):** choose and name one key (recommended: globally unique `IntegrationZaloAccount.id`/connection route key) and carry top-level `workspaceId`, `inboxId`, and account-row ID in every event/job envelope. Add a specialized workspace-scoped account lookup/decrypt/context path. Reserve `zaloUid` for provider identity/contact mapping. Add a cross-workspace same-UID test and a blocked-owner-guard test with a missing/foreign route.

#### C3 — Atomic fence publication and runtime-reference handoff are unspecified, so two sockets or stale accepted events remain possible

The plan correctly requires atomic compare-and-append (`plan.md:120-125`; `phase-05-fenced-gateway-transport.md:22-24`), but current runtime publication checks only local `active/generation/lease` state (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:391-409`, `:450-460`). `finish()` publishes `closed` and only then releases the lease (`:411-447`). A stale owner that already read a valid local lease can race a release/reacquire unless Redis checks the exact current `owner:fence` and appends in one script. The current release script only deletes the lease key (`apps/zalo-account-gateway/src/runtime/account-lease-store.ts:27-31`).

There is a second ownership hole: foundation docs deliberately use a `connect_session` runtime reference for QR and an `account` reference for long-lived ownership (`docs/zalo-account.md:26-28`). The pool keys/serializes those refs separately (`apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts:143-179`). Phase 6 says “do not open a duplicate socket” (`phase-06-channel-registration-and-inbox.md:44-51`) but does not define how the QR runtime's lease/listener is atomically transferred or revoked before the account runtime starts.

**Minimal amendment (items 5–6):** specify a Redis Lua operation that compares the current lease value `(ownerId, fenceToken)` and performs the event `XADD` atomically; test lease expiry/reacquisition between callback read and append. Specify stop ordering and the legitimate terminal-event rule. Add an explicit QR completion handoff: revoke/stop the `connect_session` runtime, wait for its lease/listener termination, then acquire the `account` runtime under a new fence; test that both refs can never own a socket concurrently.

#### C4 — QR “trusted completion” conflicts with the generic device-session implementation unless a concrete bypass contract is added

The Phase 6 text says to complete from a trusted encrypted auth event without opening a duplicate verification socket (`phase-06-channel-registration-and-inbox.md:46-51`). The existing `completeDeviceAuthorization` always resolves the provider and calls `adapter.provider.verify({ auth })` before `continueAuthorization` (`packages/connections/src/device-session-flow.ts:172-241`). The current `QrDeviceStrategy` only defines `startDeviceAuthorization`; it has no trusted-completion hook (`packages/sdk/src/lib/connection.ts:114-128`).

The gateway currently publishes raw auth in the authorization event (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:372-389`; `packages/sdk/src/lib/zalo-account.ts:71-85`), so “encrypted secret envelope” is also not yet a wire-level contract. Merely adding a service method in prose leaves the generic verify path available and can either open a second socket or accept an unverified caller.

**Minimal amendment (items 5–6):** define a named, provider-neutral “already verified device authorization” service/adapter path that (1) accepts only the trusted consumer's encrypted envelope plus session/workspace/runtime/fence proof, (2) claims the pending session idempotently, (3) skips `provider.verify` for this provider, and (4) calls the existing continuation/storage path exactly once. Define ciphertext format, AAD scope, trusted consumer ACL/decryption boundary, replay rejection, and redaction. Ordinary lifecycle/message schemas must reject raw `auth`.

### High

#### H1 — Routing Zalo group events through the existing audience handler violates the “zero Contact rows” contract

Phase 8 requires group events to be audience/metadata only and explicitly forbids direct Contacts, conversations, or automation (`phase-08-group-control.md:16-22`). The generic `ChannelAudienceEvent` type does model `groupMessage` (`packages/sdk/src/lib/shared/audience-event.ts:18-43`), but its current worker handler intentionally resolves a contact for a `groupMessage` when a leaderboard rule exists: it calls `detectContactAndConversation` (`apps/worker/src/integration/handlers/channel-audience-event.ts:64-84`) and then scores the event (`:184-200`).

Thus “enqueue `ChannelAudienceEvent`” is not equivalent to “zero direct rows” for Zalo Account. A Zalo group message can mint a Contact/ContactInbox under current behavior, even though it does not create a Conversation/Message.

**Minimal amendment (item 8):** state that Zalo Account group events use a Zalo-specific audience/metadata consumer or an explicitly non-contact event variant; they must not enter `processChannelAudienceEvent` until that handler has a no-contact branch. Add a test with an active leaderboard rule proving no Contact, ContactInbox, Conversation, Message, or automation row is created.

#### H2 — Direct-message dedupe is described more strongly than the existing persistence contract

The plan promises dedupe by account + thread type + provider message ID and replay safety (`phase-07-direct-messaging.md:25-31`, `:37-46`), but the canonical message row has only one `sourceId`, and the unique index is `(contactInboxId, sourceId, createdAt)` (`packages/database/src/schema/message.ts:80-94`). The repository's lookup is scoped to conversation/workspace and bounded by a caller-supplied time window (`packages/database/src/sharding/message/repository/sharded-message-repository.ts:2110-2165`), currently 24 hours (`:89-93`). No account/thread-type/event ledger is provided by this contract.

This is adequate only if the adapter makes account and thread type part of a stable source-ID/route contract and the replay horizon is intentionally bounded. It is not evidence for indefinite provider-ID dedupe. Likewise, outbound provider IDs are returned only after send; the provider reference explicitly says a durable idempotency key must be checked before sending (`reports/zalocrm-reference.md:297-317`). A self-echo content heuristic cannot prevent duplicate provider sends.

**Minimal amendment (item 7):** define the exact normalized `sourceId`/idempotency key (including account and thread type where required), its retention/lookback guarantee, and the pre-send durable idempotency record or existing equivalent. Test same numeric IDs across two accounts, replay beyond the lookback, text/media nested result IDs, and an ambiguous send that never retries.

#### H3 — ChannelType and registration cascade is broader than the phase’s single audit sentence

The phase says to audit every `Record<ChannelType, ...>` (`phase-06-channel-registration-and-inbox.md:18-26`), but this must include semantic `Partial` maps and runtime registries, not only compile errors. Confirmed required surfaces include exhaustive channel capabilities (`packages/utils/src/channel.ts:79-121`), connection registry (`packages/connections/src/registry.ts:141-216`), `allIntegrations`/lookup (`packages/channel-registry/src/registry.ts:55-103`, `:161-240`), and label-channel registry (`apps/worker/src/integration/handlers/inbox_labels/index.ts:10-17`). The scout also identifies builder, worker, business, flow-config, and database backfill maps (`reports/chatbotx-scout.md:186-195`).

Adding a type can compile after filling the main capability record while still silently omitting behavior from a partial map or returning no integration/context at runtime.

**Minimal amendment (item 6):** replace “audit every `Record`” with an acceptance checklist covering exhaustive and partial maps, capability defaults, all integration/connection/lookup registries, label/audience/message maps, routes, and purge/teardown. Add a registry smoke test that reaches connect, worker resolution, safe projection, and unsupported-capability paths.

#### H4 — Native label conflict semantics are not verified by the static provider evidence

The whole-document shape and read lag are verified statically (`reports/zalocrm-reference.md:396-423`), but the report also says concurrent full-document writes can lose one another and that the reference queue is not a proven fix (`:418-423`). Phase 9 assumes “latest accepted version” and conflict-aware writes (`phase-09-native-labels-and-tags.md:16-24`) without specifying whether `updateLabels` rejects stale versions, returns a canonical version on conflict, or provides compare-and-set at all. A local per-account queue prevents ChatbotX's own concurrent writers, not an external Zalo client or another process.

The provider's `conversations` values also need direct/group classification before writing contact-tag links; the plan says bounded paging but does not define the rejection rule for group IDs.

**Minimal amendment (item 9):** make provider behavior a capability gate: fixture the exact success/conflict/error response, treat successful response as the version/cache seed, refresh once on a verified conflict/uncertain result, and disable mutation if the provider has no reliable conflict signal. Define one serialized owner/fence scope for all label mutations and reject group IDs before `ContactToTagChannel` writes. Keep `TagChannel.integrationId` explicitly equal to the account-row ID (`packages/database/src/schema/tag-channel.ts:22-38`).

### Medium

#### M1 — Migration sequencing needs a hard operational gate, not only dependency prose

The main plan correctly says Phase 6 depends on an approved foundation migration and Phase 8 needs a second approval (`plan.md:53-68`). However, Phase 8 also says to generate/inspect the group migration before application (`phase-08-group-control.md:43-51`), while Phase 6's schema is still an unapplied prerequisite. Generating a later migration from a schema snapshot with the foundation migration unapplied can produce an ordering/drift problem, and DB-backed tests must not run against a schema that has not passed the gate.

**Minimal amendment (items 6 and 8):** make the gate explicit in the stop criteria: do not run DB-backed Phase 6 tests until the foundation migration is approved/applied; generate the group migration only from the post-foundation snapshot, inspect it for relations/indexes/purge, obtain a second approval, then apply and run DB tests. Add a drift check between each gate. No migration command is implied by plan verification.

#### M2 — Public API parity is an acceptance statement without an operation/error inventory

The plan requires API/CLI/MCP/UI/worker/gateway parity (`plan.md:97-107`) and Phase 6/8/9 say “public API first” or “reuse operations” (`phase-06-channel-registration-and-inbox.md:18-25`, `phase-08-group-control.md:43-51`, `phase-09-native-labels-and-tags.md:43-53`). The repository invariant requires public procedures first and derived CLI/MCP documentation (`reports/chatbotx-scout.md:186-195`), but the phases do not enumerate the actual connect/session/account, group, label, attach/detach operations or their unsupported/stale/ambiguous error semantics.

**Minimal amendment (items 6, 8, and 9):** list the public procedures and scopes for every supported operation, state which existing tag/connection procedure is reused, and require CLI/MCP regeneration through `cli-mcp-docs` from the public contract. Add a parity test or generated-doc check for the same result/error categories.

#### M3 — The proposed final commands omit repository-required wrapper checks, and one scout command has a wrong path

The plan's final gate is direct Turbo (`plan.md:71-95`). Root `pnpm lint` additionally runs agent-instruction, invariant, and Ultracite checks (`package.json:8-14`; `AGENTS.md:38-49`). Direct `pnpm turbo run check-types --concurrency=1` and the `VITEST_MAX_WORKERS=1` test command are mechanically feasible, but the direct lint command does not run the required wrapper checks. The scout's proposed business test path is also wrong: it names `__tests__/connection-store-bindings-insert.test.ts` (`reports/chatbotx-scout.md:201-213`), while the file is under `packages/business/__tests__/integration/connection-store-bindings-insert.test.ts`.

**Minimal amendment (verification text only, items 5–9):** use `pnpm lint` for the repository lint gate (or explicitly run its three constituent checks plus serialized Turbo lint), `pnpm check-types:cold` for the prescribed low-memory type gate, and the existing serialized Turbo/Vitest command for tests. Correct the focused test path and verify package filter names before execution.

## Recommended amendment order

1. Freeze item-5 fan-out, route envelope, atomic append, secret envelope, and runtime-ref handoff contracts.
2. Add the trusted QR completion hook and specialized account lookup before registering `zaloAccount`.
3. Add the no-contact group consumer and direct-message idempotency/source-ID contract.
4. Gate labels on verified conflict semantics and enumerate public API parity.
5. Apply migrations only at the two explicit approval gates, then run the corrected repository quality commands sequentially.

## Unresolved questions

- Does the deployed Redis topology permit the planned Lua compare-and-`XADD` on the same Redis instance/connection as the lease key?
- Does the live personal-account endpoint accept/reject stale native-label versions in a way that can be tested deterministically?
- Is the intended group scope truly no-contact audience/metadata, or does product intent require a separate group participant model? The current generic audience handler is not compatible with the no-contact requirement.

Status: DONE_WITH_CONCERNS
Summary: Completed the read-only assumption/contract review and wrote this report with evidence-backed Critical, High, and Medium findings limited to plan items 5–9.
Concerns/Blockers: Implementation should not proceed past transport/channel registration until fan-out, scoped route keys, atomic fencing, trusted QR completion, and the connect-session-to-account handoff are frozen.
