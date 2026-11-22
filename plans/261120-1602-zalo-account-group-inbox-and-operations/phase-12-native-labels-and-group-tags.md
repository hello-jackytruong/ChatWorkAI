---
phase: 12
title: "Native labels and group-thread tags"
status: completed
priority: P1
effort: "L"
dependencies: ["Phases 10–11"]
---

# Phase 12: Native labels and group-thread tags

## Execution status

Implementation and static verification passed on 2026-11-21. Evidence: [review](./reports/implementation-review.md). Live provider/database/instance checks remain under Phase 16 and are not claimed as completed.

## Goal

Complete conflict-safe Zalo native-label reconciliation and allow the same mapped tag to attach to direct contacts or enabled group-thread anchors without treating groups as customers.

## Contract

- `Tag` remains ChatbotX CRM truth; `TagChannel(channelType=zaloAccount, integrationId=accountId)` maps provider label IDs.
- Direct assignments use existing direct ContactInbox rows. Group assignments use only the Phase 10 group anchor ContactInbox and never a member Contact.
- Every read/update proves workspace + account + owning Inbox/group anchor scope.
- Serialize sync and all label mutations under one per-account distributed lock in addition to runtime command serialization. Define the lock key, bounded lease/renewal, ownership token, timeout behavior, and stale-owner rejection.
- Mutation is read → modify complete `labelData` → write expected version → trust the returned snapshot/version. Preserve unrelated labels and conversations.
- Retry exactly once only for a verified version conflict. Timeout/unknown provider outcome persists a durable degraded/uncertain state and pauses mutation until a fresh complete read proves the accepted version; it never detaches or accepts a local provider mapping optimistically.
- Non-empty partial, malformed, stale, duplicate-ID, or completeness-unknown snapshots are non-destructive. Do not detach local mappings/assignments from them.
- Persist per-account completeness, last accepted provider version/hash, last complete sync, mutation command, grace deadline, degraded reason, and reconciliation cursor. Protect recent successful local writes with that accepted-version/grace state so a stale pull cannot immediately revert them. After the grace window, unresolved divergence becomes a visible degraded state, not a destructive guess.
- Manual sync and a bounded periodic reconciliation job share the same service method and per-account lock.
- Generic addTag/removeTag flow/trigger paths enqueue the existing tag-sync queue for direct or group anchor rows; provider acceptance is committed before the local provider-mapping assignment/detach. Unknown or failed provider outcomes preserve existing local truth for reconciliation.
- Native label create/delete remains disabled unless live fixtures prove provider ID allocation/deletion semantics. Local Tag create/delete still works normally.

## Files to modify/create

- `packages/business/src/zalo-account/label.service.ts`, transport state helper, and tests.
- Existing tag sync dispatch in `apps/worker/src/default/handlers/sync-tag.ts` and `sync-channel-labels.ts`.
- A bounded schedule handler only if no existing channel-label reconciliation scheduler can host the job.
- Durable per-account reconciliation state plus safe status projection needed by Phases 14–15; generate/inspect a migration when existing connection metadata cannot represent the contract.

## TDD sequence

### RED

1. Direct and group label IDs map to the correct direct/group ContactInbox and never a member/customer row.
2. Same external label ID across accounts/workspaces stays isolated.
3. Concurrent attach/detach serializes and preserves unrelated document entries.
4. Returned accepted snapshot seeds subsequent writes; stale snapshots cannot lower the version.
5. Verified conflict retries once; persistent conflict/unknown outcome pauses mutation and surfaces status.
6. Empty/non-empty partial/malformed snapshots do not detach mappings or assignments.
7. Grace marker prevents stale reconciliation from reverting a recent write; confirmed newer snapshot clears it.
8. Periodic/manual reconciliation is idempotent, bounded, blocked-owner guarded, and uses the same service.
9. Existing Messenger/Instagram/Zalo OA tag sync tests stay green.

### GREEN

1. Add a small completeness/result type around provider label reads; never infer completeness from `labelData.length > 0`.
2. Add the durable reconciliation state and wrap sync/mutation/reconciliation in the fenced account lock; update accepted-version/completeness/grace only from a complete provider response.
3. Resolve provider conversation IDs first as group anchors, then direct ContactInbox rows, always within the owning account Inbox.
4. Extend generic tag-sync dispatch to pass group audience context without adding a group-label table; replace unconditional local detach-on-provider-error with provider-first commit plus later reconciliation.
5. Add a keyset-bounded reconciliation schedule and expose last successful/degraded status.

### REFACTOR

- Keep whole-document/version logic provider-specific and generic tag mapping in existing tag services.
- Reuse `TagChannel`/`ContactToTagChannel`; do not add a second label model.

## Focused verification order

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-label.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/sync-tag.test.ts __tests__/sync-tag-detach.test.ts
```

## Success criteria

- [x] Direct and group-thread tags reconcile without lost updates or cross-scope writes.
- [x] Stale/incomplete/unknown snapshots never cause destructive detach.
- [x] Flow/trigger addTag/removeTag reaches native labels for enabled group anchors.
- [x] Mutation-degraded status is machine-readable and recoverable by reconciliation.

## Rollback

Disable native label mutation/reconciliation while keeping local Tags and existing mappings. Do not delete shared Tags.
