---
phase: 13
title: "Advanced Zalo Account message lifecycle"
status: completed
priority: P1
effort: "XL"
dependencies: ["Phase 10"]
---

# Phase 13: Advanced Zalo Account message lifecycle

## Execution status

Implementation and static verification passed on 2026-11-21. Evidence: [review](./reports/implementation-review.md). Live provider/database/instance checks remain under Phase 16 and are not claimed as completed.

## Goal

Converge connection lifecycle, receipts, typing, reactions, undo/revoke, and supported delete events under duplicate, delayed, and out-of-order provider delivery.

## Event contract

- Add explicit direct/group variants for delivered, seen, typing, reaction, undo, and provider delete results. Never squeeze group member arrays into direct `recipientId` status.
- Every durable event carries workspace, account, thread, target identity, and provider timestamp/order watermark. Apply advance-only ordering; `seen` implies delivered and a later-delivered event cannot regress seen.
- Direct seen anchors may sweep only earlier own outbound messages in the same direct thread. Group receipts update only explicit `deliveredUids`/`seenUids`; no group-wide sweep without live evidence.
- Typing is ephemeral realtime state with actor UID/name and a bounded client expiry. It creates no Message/DB row and triggers no automation.
- Reactions are uniquely keyed by workspace + account + group + target provider message + reactor UID + reaction key. Receipts include the same workspace/account/group/target scope plus member UID. Add/remove and old-reaction replay are idempotent and presentation-only.
- Undo resolves nested target IDs, not the undo packet ID. Missing original messages use bounded retry/deferred lookup and then a diagnostic record.
- Outbound revoke/delete requires both provider IDs, same-thread/account ownership, policy epoch, and a live-validated provider capability. Never auto-retry an unknown outcome.
- Account-route lifecycle events map `connected`, passive `closed`, and `reauthorization_required` into the existing Connection service idempotently.
- Status/reaction/undo bookkeeping goes to the existing `low` queue; inbound messages and policy decisions stay on their current hot paths.

### Typing compatibility matrix

| Consumer | Delivery/route | Payload contract | Compatibility |
|---|---|---|---|
| Authenticated direct Inbox | Existing workspace event, filtered by `conversationId` in chat consumer | Existing `{ conversationId, typing, seconds }`; optional audience/expiry fields ignored | No behavior change |
| Authenticated Zalo group Inbox | Existing workspace event, filtered by `conversationId` before store update | Adds bounded `audience=zaloAccountGroup`, safe actor UID/name, and `expiresAt` | Only active/scoped conversation renders actor |
| Guest webchat | Existing guest route | Existing `{ typing: boolean }` shape | Unchanged; group actor fields are never emitted |

Keep the protocol extension backward-compatible and optional. Update the protocol schema, workspace provider dispatch, chat realtime consumer/store, and guest compatibility test together; do not create a second typing transport.

## Persistence choice

Do not store unbounded per-member receipt/reaction arrays in Message JSON. Add provider-specific receipt and reaction state tables with account-inclusive composite uniqueness and leading workspace/account/group indexes. Define retention, Message undo/delete tombstone cleanup, and bounded workspace purge registration explicitly. The tables have no FK to the sharded Message table; local message ID/createdAt is an optional resolved pointer.

## Files to modify/create

- SDK schemas/unions in `packages/sdk/src/lib/zalo-account.ts`.
- Gateway ports, `zca-client.ts`, runtime, normalizers, command executor, and fixture tests.
- Provider-specific receipt/reaction schema/repository/business service plus relations/types/purge coverage/migration.
- `apps/worker/src/events/zalo-account/handler.ts`, low-queue job types/handlers, connection lifecycle branch, and existing message status/delete/reaction integration handlers.
- `packages/realtime-protocol` typing payload extension, `workspace-realtime-provider`, chat realtime/store consumption, and guest-webchat compatibility tests in Phase 15.

## TDD sequence

### RED

1. Fixtures G-08–G-12 cover merged delivered/seen, duplicate/reordered events, typing absence, reaction replay/removal, nested undo target, and delete capability errors.
2. Direct seen sweep updates only earlier own messages in the same thread and never another account/thread.
3. Group receipt rows merge per member monotonically; duplicate batches are no-ops and the same provider group/message observed by two accounts never collides.
4. Reaction add/remove is idempotent by workspace/account/group/actor/target/reaction and never emits `message:received` or automation.
5. Typing publishes scoped realtime with expiry, filters by conversation before store update, preserves the guest/direct payload contracts, and produces zero DB writes.
6. Undo before original message retries boundedly; undo after persistence tombstones exactly the target once.
7. Passive close/reauth updates the correct Connection and cannot cross workspace/account.
8. Low-queue routing preserves hot message priority and blocked-owner behavior.
9. Unsupported/unknown outbound delete is explicit and never replayed.

### GREEN

1. Extend the transport schemas and gateway listener with bounded provider normalization.
2. Generate/inspect receipt/reaction state migration; never apply without approval.
3. Add advance-only business methods, account-inclusive keys/watermarks, retention/tombstone cleanup, and keyset-bounded purge behavior.
4. Route durable bookkeeping through the low queue with deterministic job IDs that contain no colon.
5. Publish inbound typing through the existing authenticated workspace event with `conversationId`; the chat consumer filters before store update and expires it client-side. Keep the guest route unchanged.
6. Resolve undo/revoke targets by scoped provider ID and update Message/realtime idempotently.
7. Add outbound typing via the provider `sendTypingEvent` command for direct/group conversations, but treat delivery as best effort.
8. Map account lifecycle to existing connection states/reasons through the connection service.

### REFACTOR

- Share direct/group timestamp ordering helpers, not event payload types.
- Keep reaction/receipt provider semantics in Zalo-specific services.
- Keep lifecycle connection mapping separate from QR connect-session handling.

## Focused verification order

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account-transport.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/command-executor.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-message-lifecycle.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/realtime-protocol exec vitest run
```

## Success criteria

- [x] Receipt/reaction/undo state converges under duplicate and reordered events.
- [x] Typing is ephemeral and scoped; account lifecycle is durable and scoped.
- [x] No event regresses a newer timestamp or triggers customer automation.
- [x] Delete/revoke is exposed only after live capability proof.

## Rollback

Stop new lifecycle consumers and typing/reaction display while leaving message receive/send active. State tables remain for audit; do not drop them during application rollback.
