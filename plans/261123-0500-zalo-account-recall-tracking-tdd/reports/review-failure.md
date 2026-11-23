# Failure-mode and factual contract review

Status: DONE_WITH_CONCERNS

Read-only adversarial review, 2026-11-23. Read plan, all three completed phase drafts, scope/decision report and resource/TDD matrix. No source edits, tests, lint, typecheck, build, migrations, or provider calls. Findings below concern execution-ready plan gaps, not observed regressions from implementation. Authors are editing concurrently; the final status section records reread results rather than treating the original draft as current.

## High — fallback and queued legacy undo still bypass the new protocol

Plan phase 1 step 1 names fallback normalization, but its file inventory does not include `apps/worker/src/events/zalo-account/handler.ts`. That actual event consumer routes `direct_undo` to `IntegrationJobAction.deleteIncomingMessage` at **source `:219`–`:237`**, not to `zaloAccountMessageLifecycleService`. Normalizing `zca-client` and editing `zalo-account-thread-event.ts` cannot repair this route. Already queued generic delete jobs also survive deployment.

Concrete failure: a redelivered `direct_undo` envelope (or previously queued ZA deleteIncomingMessage job) runs the generic path after rollout. The shared repository still explicitly soft-deletes parent plus children (`packages/database/src/sharding/message/repository/sharded-message-repository.ts:1095`–`:1123`). Original recall metadata/tombstone and pending repair are bypassed; replies are incorrectly recalled, violating R01/R12/R13.

Minimal fix: explicitly add the event consumer to phase-1 inventory and reroute ZA direct_undo to the new lifecycle service with timestamp provenance/received time. Also define handling of old ZA deleteIncomingMessage jobs: route them through the ZA service where authoritative refs can be resolved, or reject/park for bounded repair, never invoke generic delete. Characterization of all non-ZA jobs must remain unchanged. Add RED tests through the real event-consumer entrypoint and a serialized pre-rollout delete job, rather than only normalized live SDK events.

## High — applied and realtime-published are conflated; crash/Redis failure leaves clients permanently stale

Phase-1 schema has `appliedAt` but no publication marker; pending index selects only appliedAt IS NULL. Protocol T3 marks applied in main DB, then step 8 publishes after commit, and says duplicate events have no second side effect. Thus there is no durable obligation to publish after applied commit.

Source evidence: realtime is an independent process-local coalescing map/timer (`packages/business/src/platform/realtime-broadcast.ts:58`–`:75`) and Redis append happens separately (`:102`–`:124`). More importantly, the plan's existing `queueWorkspaceRealtimeEvent` helper **swallows append errors** (`:303`–`:316`). The existing group outbox deliberately separates publication with `publishedAt` (`packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:256`–`:260`) and recovers only unpublished rows (`:298`–`:305`); this cannot repair a separate recall ledger row marked applied.

Concrete failure: user has original cached. Recall intent/marker commit succeeds, process dies before Redis append, or append fails and queue helper resolves. Recovery skips applied ledger; event retry sees duplicate and suppresses it. Open Inbox continues displaying the pre-recall original until unrelated refetch/reconnect, and no “Xem nội dung đã lưu” boundary is applied to that cached message. New server reads are safe but do not repair already-open state.

Minimal fix: add `publishedAt` (or equivalent `publishPending`) on the **same** narrow ledger and include pending publication in indexed repair. Publish the safe monotone marker at least once with a rejecting existing publisher (`publishWorkspaceRealtimeEvent`, or narrow confirmed wrapper); set publication marker only after accepted Redis append. A crash after append/before DB mark can repeat the same safe marker; do not require exactly-once event delivery. Keep notifications/automation suppressed separately. RED tests: death after applied commit/before append, Redis append failure, death after append/before publishedAt, duplicate safe-event replay. No third table/queue needed.

## Medium — shared recovery budget has contradictory owners and can starve recall or exceed lease

Phase 1 specifies 25 intents/10 seconds, while resource matrix specifies 50 targets/40 seconds. Existing host `apps/worker/src/schedule/handlers/recover-zalo-group-inbox.ts:14`–`:18` holds a 50-second distributed lock; `:22`–`:43` first spends its 40-second deadline on prepared chat sends, then group recovery (`:44`–`:69`). Adding an independent 10- or 40-second recall loop after that can overrun lease; putting recall last with the same exhausted deadline can starve it indefinitely under sustained send recovery backlog.

Minimal fix: define one authoritative host deadline and bounded per-category allocation/rotation, with all three categories sharing the existing lease. Pass remaining time down to locator/DB statement timeouts and stop before starting a target that cannot fit. Reconcile phase-1 and matrix batch numbers. RED test should simulate perpetual prepared-send backlog and prove recall still progresses without extending host lifetime or starting another worker. This is fairness within requested recovery, not new infrastructure.

## Medium — explicit resource deletion is an assertion, not yet an executable fence for unbound intents

Phase 1 step 9 promises account/inbox/group/contact/conversation deletion will prevent resurrection, but inventory only adds workspace drain registration. Workspace guard is narrower than that claim: `packages/database/src/repositories/workspace/repository.ts:34`–`:45` only holds Workspace KEY SHARE and checks purgeStartedAt. It neither checks a contact deletion generation nor prevents null-pointer recall intent from later binding to a newly provisioned contact in the same Inbox/thread.

Actual person deletion records MessageCleanup then deletes Contact in one transaction (`packages/business/src/contact/service.ts:808`–`:847`). Cleanup is keyed by inbox/source and **can be canceled when contact returns** (`packages/business/src/message-cleanup/service.ts:106`–`:125`); its physical cleanup is described as not wired to a cron/queue (`:45`–`:51`). Therefore a plan cannot claim this existing helper alone is an irreversible deletion/recovery fence.

Concrete scenario to settle in tests: an unknown-DM recall ledger exists with null contact/conversation pointers; contact is created then explicitly deleted before repair binds; a later message recreates that thread. Old pending repair must not attach the pre-deletion original/placeholder to the new lifecycle merely because account/inbox/thread still match. Bound rows may cascade away; unbound rows have no contact FK and survive.

Minimal fix: specify the ZA-only deletion integration and cutoff under the existing inbox/source deletion transaction, including unbound intents, plus a recheck inside T3 before shard write. This may use a terminal/canceled state or deletion cutoff on the same ledger; no general retention framework is needed. Add actual owning contact deletion/cleanup file(s) to inventory if required. Preserve the repository's existing deliberate return-contact behavior for non-ZA. Explicitly distinguish scheduled deletion, purgeStartedAt, actual Contact removal, and cancellation rather than using “purge guard” for all four.

## Verified decisions retained / no finding

- Do **not** replace shared `deleteBySourceId`; source proves its parent/reply semantics. A separate exact-one ZA update is justified and correctly planned.
- Canonical pointer requires id+createdAt because Message is sharded and has no main DB FK (`packages/database/src/schema/message.ts:58`–`:68`); plan preserves that tuple and avoids fake cross-store transaction guarantees.
- Existing group outbox skips undone/discarded/no-payload rows (`group-inbox-repository.ts:158`–`:164`) and clears payload after publish (`:256`–`:260`). Plan correctly calls out narrow late-original persistence changes, preserving schema and stable identity. No need to generalize the group outbox into DM.
- Full-target advisory lock, primary/fail-on-error exact lookup, finite cursor rather than 90-day correctness cutoff, retained body/attachments, 90-day receipt/reaction retention, separate native attempt ledger, and onlyMe=true are supported by source and appropriate to scope.
- No duplicate enum finding: user/group correction is already assigned to author. Do not create a separate issue merely from stale direct/group prose while that edit is in progress.
- No requirement to run code gates in this PLAN review. Proposed tests are unexecuted; DB/provider proof remains a rollout prerequisite.

## Phase-2 contract observations

Installed `zca-js@2.1.2` source confirms the proposed call shapes: undo object at `dist/apis/undo.js:18`, nested delete destination and explicit onlyMe semantics at `dist/apis/deleteMessage.js:17`–`:24`, deleteChat boundary and onlyMe=1 at `dist/apis/deleteChat.js:22`–`:37`. Native durable claim before network correctly prefers unknown over unsafe replay. Do not use ZaloCRM's known-112 retry loop as a reason to replay ambiguous operations. Static source does not establish success status values or live ownership/time-window restrictions; plan correctly leaves gate closed until proof.

## High — native applied outcome must atomically create its lifecycle repair obligation

Phase 2 says confirmed undo applies recall intent through the shared service, but does not specify atomicity of NativeOperationAttempt.applied versus recall-ledger intent. Its native status index supports inspect/reconcile but gives no applied-result repair transition. Source gateway executes provider work then completes independent state (`apps/zalo-account-gateway/src/transport/command-executor.ts:158`–`:165`); native provider success is therefore an external effect and cannot be rolled back with database failure. Current Redis claim is TTL-limited (`:108`–`:112`, `:132`–`:138`), which the revised gateway CAS correctly supplements.

Concrete failure: SDK undo returns a proof-validated success; native attempt is committed applied; process dies before inserting recall intent. Provider event may be lost or delayed. Main durable command blocks SDK replay, but recall repair has no row, so operation reads applied while ordinary timeline still has no recall state. Delete-only-me has the analogous missing providerDeletedForMeAt annotation.

Minimal fix: commit provider-confirmed applied result **and** the relevant recall/provider-delete durable projection obligation in one main DB transaction. Then exact shard repair runs outside that transaction through phase 1. Alternatively, an explicit applied-but-unprojected state/marker on native attempt must be indexed and repaired by the same bounded host without calling SDK again. Test crash at each result/intent boundary and recovered applied status never re-enters SDK. This uses the same two ledgers, no added feature or queue.

## Final reread / disposition

- **Resolved in draft:** direct_undo event-envelope route is now explicitly in phase-1 protocol/inventory; `user/group` enum corrected; phase 2 explicitly requires gateway-side durable pending→dispatched CAS immediately before each SDK call, with only winner dispatching even after Redis TTL. These are source-aligned fixes, no new CAS finding.
- **Partly resolved:** phase-1 publishedAt/index and applied-but-unpublished repair are now present. The plan still must explicitly call a **rejecting** realtime publisher; `queueWorkspaceRealtimeEvent` swallows errors. Treat success as confirmed Redis append rather than resolved best-effort helper. Once the rejecting publisher is named, close this high finding.
- **Partly resolved:** event-envelope legacy direct_undo reroute does not itself cover already-enqueued `IntegrationJobAction.deleteIncomingMessage` payloads. Keep the old-job RED case and explicit no-generic-delete handling before closing the first finding.
- **Partly resolved:** phase 1 now places its 10-second recall allocation inside 40-second host budget; matrix numbers and category fairness must agree. No need to expand resources.
- **Open:** native applied/intent atomicity above and executable explicit-deletion handling for unbound intents. Both have narrow fixes within full R01–R16 scope.
- Placeholder/concurrency design is otherwise coherent: reserve pointer in main before shard write, serialize ingress/placeholder/group repair under same target lock, fill original idempotently into same tuple, retain monotone recall and use primary failure semantics. Required RED cases should interleave **after pointer reservation/before shard insert** and **after placeholder insert/before applied commit** against late original arrival; mocks that only inspect call order are insufficient evidence.
- Full phase 3 now covers dialog ACL/cache clearing, monotone target/quote scrubbing without reply-body deletion, stored-only media, distinct labels, gate-off behavior, safe rollout/rollback. No deficiency is inferred from its former stub.

Close remaining items by tightening protocol/test language, not by adding infrastructure or reducing R01–R16.
