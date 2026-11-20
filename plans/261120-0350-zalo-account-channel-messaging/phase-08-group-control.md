---
phase: 8
title: "Controlled Zalo group sending"
status: pending
priority: P1
effort: "M"
dependencies: ["Phase 7", "Approval before group migration application"]
---

# Phase 8: Controlled Zalo group sending

## Goal

Expose Zalo groups as provider-scoped resources and allow explicit policy-controlled sending without pretending a group is a Contact or direct Inbox conversation.

## Product contract

- Group belongs to one Zalo Account/workspace and is unique by provider group ID within that account.
- Sync/list/get return safe metadata plus local send policy; `sendEnabled` defaults false.
- Send requires scoped authorization, explicit account/group IDs, enabled policy, current fence, and supported text/image/file payload.
- Group messages and membership/update events use a dedicated Zalo group-resource job/consumer and metadata refresh. They must not enter `processChannelAudienceEvent` or direct-message handlers, because the generic audience handler may resolve Contacts for leaderboard scoring.
- Public send is one group per command, POST/mutation-scoped, serialized per account, protected by existing workspace/provider rate limits and the Phase 5 `pending/applied/unknown` idempotency state.
- No bulk/all-group send, broadcast integration, group creation, moderation, member persistence, or generic group framework.

Public operations: `listZaloAccountGroups`, `getZaloAccountGroup`, `syncZaloAccountGroups`, `updateZaloAccountGroupPolicy`, and `sendZaloAccountGroupMessage`. Read and mutation scopes remain distinct; UI/CLI/MCP call the same services.

## Data model

Add `IntegrationZaloAccountGroup` with workspace/account/provider IDs, safe bounded metadata, `sendEnabled` (application and DB default false), last sync/timestamps, uniqueness on account + provider group, indexed FKs, and cascade. Do not persist full member lists.

## Key files

Add database schema/relations/migration, group repository/service under `packages/business/src/zalo-account`, public group API/UI, gateway group discovery/detail/send adapter, integration methods, audience-event bridge, purge coverage, and CLI/MCP/docs. Generate and inspect the migration only; application needs explicit approval.

## Tests before implementation (RED)

1. Scoped idempotent upsert/list/get by account/provider ID.
2. New group defaults disabled in app and DB schema.
3. Disabled/missing/stale/cross-scope/unauthorized send fails before gateway.
4. Enabled send uses `ThreadType.Group`, correct ID, supported schema, and no ambiguous retry.
5. Inbound group activity uses the dedicated resource consumer and creates zero Contact, ContactInbox, Conversation, Message, leaderboard, or automation rows.
6. Sync handles rename/removal/inaccessibility without unbounded member storage.
7. Partial/rate-limited chunks cannot delete groups: only a complete `syncRunId` generation marks missing; uncertain groups become inaccessible/tombstoned and sending is disabled.
8. Indexed bounded account/workspace purge removes group rows.
9. Direct user messaging remains unchanged.

## Implementation steps (GREEN)

1. Write schema tests, add table/relations/exports/indexes, generate and inspect migration without applying it.
2. Add scoped repository/service for bounded sync/list/get/policy/send authorization, with paged sync generations, completeness state, and bounded inaccessible tombstones.
3. Add serialized gateway commands for discovery/detail/supported send and normalize provider permission errors.
4. Add public scoped API first; private UI reuses service.
5. Route listener group events to the dedicated resource consumer before both generic audience and `incomingMessage` paths.
6. Add i18n settings for sync/status/enable/disable/send test and CLI/MCP/docs parity.
7. After explicit approval only, apply migration in a separate controlled step and run DB tests sequentially.

## Refactor while green

Keep policy in business service, provider operations in gateway, explicit Group routing, and no generalization until a second provider proves shared semantics.

## Tests after implementation

Before approval, run unit/contract/drift tests sequentially. After approval/application, run database, business, focused worker, and builder API tests one at a time, then final gates.

## Todo

- [ ] Freeze group contract/policy defaults.
- [ ] Add schema/migration/index/purge tests; inspect migration only.
- [ ] Add scoped service and discovery/sync.
- [ ] Add guarded group send.
- [ ] Route activity without direct Inbox/automation.
- [ ] Add public API/UI/CLI/MCP/docs parity.
- [ ] Obtain migration approval before application/DB tests.

## Success criteria and rollback

Groups require explicit enablement; cross-scope/stale sends fail closed; group activity never creates direct-chat records/automation; sync/purge are bounded; direct messaging stays unchanged. Stop if product requires group Inbox/automation—create a separate plan. Roll back by disabling group operations and setting policies false.
