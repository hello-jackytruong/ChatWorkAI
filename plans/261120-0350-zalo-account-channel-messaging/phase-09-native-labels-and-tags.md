---
phase: 9
title: "Native labels and ChatbotX tags"
status: pending
priority: P1
effort: "M"
dependencies: ["Phase 7", "Phase 8 group boundary"]
---

# Phase 9: Native labels and ChatbotX tags

## Goal

Synchronize Zalo native labels and attach/detach them for direct contacts while preserving account-wide document versioning and existing ChatbotX tags.

## Contract

- `getLabels()` returns `{labelData, version, lastUpdateTime}`; mutation replaces the complete `{labelData, version}` document.
- Map definitions through `TagChannel(channelType=zaloAccount, integrationId=accountId, externalLabelId=providerLabelId)`.
- `ContactToTagChannel` applies only to direct ContactInbox rows owned by that account's Inbox.
- Serialize all label mutations per account. Use latest accepted version, preserve unrelated data, and update a response-seeded version cache.
- Accept destructive diff only from a schema-valid complete snapshot with a non-regressing version. Empty/partial/malformed/stale snapshots leave local rows unchanged. On verified conflict/uncertain write, do one bounded refresh/reconcile; never blind-retry.
- Provider deletion removes only mappings proven by `workspaceId + channelType + accountId + owning Inbox`; never use an ID-only destructive helper. Shared workspace Tags remain.
- Group label membership never enters contact-tag rows; expose it only on the Phase 8 group boundary if useful.
- No OA endpoints, label prefixes, speculative table, or generic label framework.

Public capability reuses existing tag list/create/attach/detach procedures when scopes/errors suffice; add only `syncZaloAccountLabels` and read-only sync status if absent. CLI/MCP/docs expose the same mutation-disabled/conflict semantics.

## Key files

Extend gateway zca adapter/pool, SDK schemas, integration label capability, worker channel-label/tag sync dispatch, and scoped tag services only where generic extension is missing. Add fixture tests across gateway/business/worker. No schema is planned; stop and replan if current mapping keys are insufficient. Keep account-scoped mutation intent/version in the command idempotency/result store; after crash/lease handoff or ambiguous response, pause writes until a fresh read proves the accepted version or an operator resolves it.

## Tests before implementation (RED)

1. Fixtures validate document/version shape, malformed/duplicate entries, and direct/group IDs.
2. Full sync idempotently creates/updates definitions and direct assignments.
3. Same external ID across accounts/workspaces stays isolated.
4. Attach/detach preserves unrelated labels/conversations and uses latest version.
5. Concurrent account mutations serialize without lost updates.
6. One verified conflict refreshes/reconciles; persistent conflict or lack of a reliable provider conflict signal disables mutation and fails visibly without overwrite.
7. Deletion removes affected mapping/assignments but preserves shared Tags.
8. Group IDs never mutate contact-tag rows.
9. Existing Messenger/Instagram and local-only tag tests stay green.

## Implementation steps (GREEN)

1. Freeze fixture schemas and direct/group classification.
2. Add fenced gateway label read/update commands.
3. Add per-account serialized mutation helper with version seed and bounded conflict refresh.
4. Extend existing channel-label sync for Zalo Account and map through services that prove workspace/account/Inbox ownership on every read/write/delete.
5. Resolve direct thread IDs only through owning account Inbox, with bounded paging.
6. Attach/detach provider-first; update/reconcile local assignment only after acceptance.
7. Handle deletion/rename/malformed documents safely.
8. Reuse public/UI/CLI/MCP tag operations when sufficient; add only missing capability exposure.
9. Add redacted sync-lag/conflict/provider-rejection metrics.

## Refactor while green

Keep whole-document/version logic provider-specific, generic mapping in tag services, and serialization in account pool. Avoid cache beyond immediate response-seeded version safety.

## Tests after implementation

Run focused gateway label, business tag-sync, worker label, then full worker suites sequentially with one worker, followed by final gates.

## Todo

- [ ] Freeze label/version fixtures and classification.
- [ ] Add fenced read/update commands.
- [ ] Serialize whole-document mutations with conflicts.
- [ ] Reuse scoped TagChannel/direct assignment services.
- [ ] Add sync/attach/detach/rename/delete reconciliation.
- [ ] Exclude group membership from contact tags.
- [ ] Add API/UI/CLI/MCP parity and sequential regression evidence.

## Success criteria and rollback

Definitions/assignments converge idempotently; concurrent writes preserve unrelated data; cross-scope and group-as-contact contamination are impossible; existing channels remain unaffected; no new schema/framework. If live payload/version semantics differ, stop rollout and update fixtures. If conflicts are unreliable, keep read-only sync and disable mutation. Roll back by disabling Zalo native-label sync/mutation while preserving local Tags.
