# Assumptions, scope and contract review

Plan-only review, 2026-11-23. Read the plan, all three phases, scope/decisions, TDD/resource matrix and security/failure reviews. Used the code-review skill and inspected current callers/configuration. No source/test/migration changes, provider calls, lint, types, build or tests run. CodeGraph shell entry point was unavailable (`command not found`), so native source reads were used. Full R01–R16 scope is retained.

## High — explicitly cover the receipt/reaction realtime publisher, not only recall/message-created events

Phase 2 promises all realtime output uses the pure safe projector, but the concrete receipt/reaction publisher is not named in its integration steps or RED cases. Phase 1 lists `message-lifecycle.service.ts` for routing undo, and its tracking language focuses on keeping state/locking. An implementer can satisfy those listed changes while leaving a separate original-content publisher intact.

Source evidence:

- `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:193–195,206–219` intentionally persists the full group payload under `Message.contentAttributes.zaloAccount.group`, including original text and attachment references. Retention correctly leaves this in storage.
- `packages/business/src/zalo-account/message-lifecycle.service.ts:171–196` applies receipt/reaction, rereads the raw Message and publishes **all** `...message.contentAttributes` in `messageContentUpdated`. This is independent of the new recall publisher, message list signer and received-message publisher.
- `apps/builder/src/features/chat/chat-realtime.tsx:277–286` forwards that event to the store. `apps/builder/src/features/chat/store/chat-store.ts:1308–1318` replaces contentAttributes with the received object; it does not run the new lifecycle event path automatically.

Concrete failure: locally hide a persisted ZA group message, safely scrub its ordinary DTO and cache, then receive a newer reaction or receipt. Local-hide does not mark the group identity undone, so current tracking remains eligible. The tracking event contains retained original text/provider attachment URLs and can restore them into ordinary chat state. Even a client merge that hides the bubble cannot undo the server-side websocket disclosure. A post-recall tracking event has the same risk wherever latest-state tracking continues as planned.

Minimal fix: explicitly require this existing receipt/reaction publisher to apply the **same ZA-only safe projector and pending-ledger fence before serialization**, preserving only safe tracking metadata and lifecycle revision. Preserve ordinary non-ZA behavior and avoid signing/storage lookups. Include `messageContentUpdated` in monotone client merge handling. No new service/table/queue or general realtime framework is needed.

RED: persist a group payload containing sentinel original text and provider URL; hide it locally; apply a newer reaction/receipt through the real lifecycle entrypoint; capture serialized realtime output and pass it through the existing content-updated handler/store. Assert no sentinel/URL in event or ordinary cache, lifecycle revision is retained, tracking query invalidation still occurs, and unrelated channels keep existing behavior. Also cover the pending-intent-before-shard-marker window and a stale content-updated event delivered after the recall event. Extend the existing lifecycle/chat-store suites rather than inventing another harness.

## Final reread: resolved candidates and retained decisions

- `lifecycleRevision`, re-arming appliedAt/publishedAt only on new transitions and revision-CAS completion now appear in phase 1. This closes the candidate where local-hide followed by recall/provider-delete could lose the second repair obligation. Do not add a second ledger or event-sourcing history.
- Native applied + recall/provider-delete intent atomicity, rejecting realtime publisher + publishedAt, queued legacy-delete handling, translation enrichment ordering and the gateway zca-client test's Create label are now addressed or already tracked by the other reviews; no duplicate finding is raised here.
- Two narrow metadata tables and two ZA services plus a pure projector fit the requested resource boundary. Shared repository additions must remain explicit ZA exact methods and conditional reader branches; no evidence justifies broadening identity/send-attempt schemas or changing generic channel deletion.
- Proposed `VITEST_MAX_WORKERS=1`, workspace names, existing named characterization files, and database `test:db` file-filter invocation match inspected scripts/configuration. This is static command verification only; no tests were run. Existing DB opt-in helper skips the sentinel port-1 URL and requires an explicitly prepared test database.
- Shared-recovery fairness/resource-matrix mismatch and unbound-intent explicit-deletion fence are already documented in `review-failure.md`; they remain controller-owned corrections and are not relabeled as additional discoveries.

Status: DONE_WITH_CONCERNS
Summary: One additional high-signal caller/test requirement: receipt/reaction `messageContentUpdated` must use the same safe ZA projector and client monotone merge. No additional infrastructure, scope cuts or unrelated channel changes are needed.
Concerns: Existing failure-review items must be closed in the final plan. No implementation/runtime verification is claimed.
