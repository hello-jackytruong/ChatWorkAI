# ChatbotX gap analysis: Zalo Account checklist items 10–16

## Scope and reading basis

This is a read-only audit of the current tree. I read the repository guidance,
`README.md`, `docs/zalo-account.md`, the foundation plan, the channel/messaging
plan, and channel/messaging phases 05–09 before tracing the implementation. No
build, test, lint, install, generator, migration, or production edit was run.

The recovered numeric checklist text for items 10–16 is not present in the
repository. To keep the mapping explicit rather than infer from filenames, the
seven rows below use the seven dimensions named in this assignment, in order:

1. group resource versus Full Group Inbox;
2. group policy and group operations;
3. native label/tag synchronization;
4. lifecycle, status, reaction, typing, undo, and delete behavior;
5. public API;
6. CLI/MCP parity; and
7. builder UI.

Where a capability is complete only for the already-shipped resource scope, the
matrix says so explicitly. “Full Group Inbox” means a group thread with stored
messages, participant/member identity, Inbox listing/detail/realtime behavior,
and the corresponding send/event lifecycle; it does not mean the existing group
metadata table or its test-send input.

## Executive finding

The current implementation is a sound, deliberately narrow group-resource
slice, not a Full Group Inbox. Existing code syncs account-scoped metadata,
keeps new/uncertain groups send-disabled, coalesces group activity into a
metadata refresh, and sends only after an account/group/policy/fence check. The
repository’s own contract makes that boundary explicit: groups are not Contacts
or Inbox conversations (`docs/zalo-account.md:117-137`), and the phase-08 tests
require group activity to create zero Contact, ContactInbox, Conversation,
Message, leaderboard, or automation rows (`plans/261120-0350-zalo-account-channel-messaging/phase-08-group-control.md:35-45`).

Items 10–12 are therefore implemented for the existing resource contract, with
two hardening gaps: Full Group Inbox is absent, and label sync does not prove
that every non-empty provider snapshot is complete before applying a destructive
diff. Item 13 is partial: direct delivered/read receipts and direct undo/delete
are wired end to end, but account lifecycle events are not persisted by the
account-route worker, reactions and typing have no event contract, and group
undo is explicitly ignored. Items 14–15 are implemented for the current public
group-resource surface through the OpenAPI-driven API/CLI/MCP path. Item 16 is
partial: settings exposes sync, policy, and a test send, but there is no group
conversation Inbox, participant view, or realtime group message view.

## Matrix

| Item | Current status | What is actually implemented | What remains missing | Minimal extension point |
|---|---|---|---|---|
| 10. Group resource vs Full Group Inbox | **Partial** | `IntegrationZaloAccountGroup` is a workspace/account-scoped metadata and policy resource. Group activity is a coalesced refresh only. | No group Contact/ContactInbox/Conversation/Message, participant/member persistence, group history, Inbox list/detail, or group realtime stream. | Preserve the resource table and add a separate group-thread/message read model if Inbox is accepted; do not mint synthetic Contacts to fit the existing 1:1 schema. |
| 11. Group policy/operations | **Implemented for controlled resource sending; missing for full group administration** | Sync/list/get, disabled-by-default policy, inaccessible tombstone, and text/image/file send are scoped to the exact account and group. | No member management, moderation, group creation, bulk send, group message echo/history, or group undo/delete. | Extend `zaloAccountGroupService`, repository, and gateway command set for an explicitly approved operation; keep fail-closed policy and existing fenced transport. |
| 12. Labels/tags | **Partial** | Versioned native labels map through `TagChannel`; assignments resolve only to existing direct `ContactInbox` rows in the owning Inbox, and known group IDs are excluded. Empty snapshots and version regressions are guarded. | No completeness marker for a non-empty partial snapshot; no durable mutation-disabled state after an ambiguous/conflict-unreliable write; exclusion depends on currently synchronized local groups. | Add complete-snapshot/accepted-version evidence and a visible read-only/mutation-disabled state around the existing `zaloAccountLabelService`; keep group membership out of contact-tag rows. |
| 13. Lifecycle/status/reaction/typing/undo/delete | **Partial** | Runtime lifecycle events exist; direct messages, delivered/read status, and direct undo/delete use canonical worker pipelines with scoped dedupe. | Account-route lifecycle events do not update durable `Connection` status; reaction/typing schemas, listeners, worker routing, and UI are absent; group undo is dropped. | Extend SDK union → gateway ports/listener → account worker handler → generic reaction/status/delete/realtime handlers. Persist only durable status; keep typing ephemeral. |
| 14. Public API | **Implemented for current resource scope; missing Inbox/event operations** | Public router exposes account list/get, group list/get/sync, label sync, policy update, and group message send under `channels`. | No group conversation/messages/members/reactions/typing/history/lifecycle operations. | Add public procedures first for any new group-thread capability and have UI/CLI/MCP call the same business service. |
| 15. CLI/MCP | **Implemented for current OpenAPI surface; missing Inbox/event operations** | CLI commands and sync name overrides are present; MCP dynamically consumes the public OpenAPI spec and tests classify group send as outbound. | No commands/tools can exist for missing group Inbox/event operations. | Extend the public router/spec and add only command-name/HITL overrides required by the generated shape; refresh parity tests/docs. |
| 16. Builder UI | **Partial** | Settings page loads accounts and groups; UI supports group sync, label sync, enable/disable, and one text send with accessibility gating. | No group Inbox route, thread/message history, participants, reactions/typing, or realtime group activity UI. Group mutations use `router.refresh()` rather than a dedicated group query invalidator. | Keep the settings controls; add a group resource query/read model and a separate Inbox thread surface once the data contract exists. |

## Evidence by item

### 10 — group resource is real; Full Group Inbox is not

The schema is conclusive. `IntegrationZaloAccountGroup` has only workspace,
account, provider group ID, bounded metadata, sync state, accessibility, and
`sendEnabled`; it has no `contactId`, `inboxId`, `conversationId`, member table,
or message table (`packages/database/src/schema/integration-zalo-account.ts:53-88`).
The repository scopes every list/find/update by both workspace and account and
marks rows outside a completed sync generation inaccessible and unsendable
(`packages/database/src/repositories/integration-zalo-account/group-repository.ts:6-35,38-117`).
The service then lists, syncs, updates policy, and sends against that row only
(`packages/business/src/zalo-account/group.service.ts:24-128`).

The existing Inbox model cannot be reused by simply inserting a group ID:
`ContactInbox` requires a `Contact` and an `Inbox` (`packages/database/src/schema/contact-inbox.ts:103-123`),
`Conversation` requires a `Contact` (`packages/database/src/schema/conversation.ts:22-57`),
and the hypertable `Message` requires `conversationId` and `contactInboxId`
(`packages/database/src/schema/message.ts:55-82`). A group ID is not a direct
contact identity. Creating a synthetic Contact would contaminate contact,
audience, automation, analytics, and tag semantics that the current design
explicitly avoids.

The event path also proves the boundary. Provider group messages normalize to a
small `{threadId, providerMessageId}` activity record, not message content
(`apps/zalo-account-gateway/src/runtime/provider-message.ts:27-30,148-159`).
The runtime publishes that activity only (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:413-422,558-571`),
and the worker turns it into a delayed/coalesced `zaloAccountGroupRefresh` job
(`apps/worker/src/events/zalo-account/handler.ts:165-183`; the job only calls
`zaloAccountGroupService.sync` at `apps/worker/src/integration/handlers/zalo-account-group-refresh.ts:4-12`).
The focused worker test asserts that the event creates neither an
`incomingMessage` nor a `channelAudienceEvent`
(`apps/worker/__tests__/zalo-account-events.test.ts:268-316`).

**Recommended boundary:** keep `IntegrationZaloAccountGroup` as the stable
resource/policy row. If Full Group Inbox is approved, add a separate,
group-native thread/message/member model keyed by workspace + account +
provider group ID, with its own retention, dedupe, participant identity, and
realtime mapping. Only after that model is proven should the builder Inbox be
adapted. Do not route group activity into the current direct-message path.

### 11 — group policy and operations

The policy gate is implemented and fail-closed. New rows write
`sendEnabled: false` and `accessible: true`; an upsert refresh preserves the
existing policy rather than silently enabling a group
(`packages/database/src/repositories/integration-zalo-account/group-repository.ts:53-85`).
Missing groups become inaccessible and `sendEnabled: false` only after the
complete sync marker is applied (`:94-117`). Policy updates require an
accessible, account-scoped row (`:119-139`), and send refuses a missing,
inaccessible, or disabled row before calling the gateway
(`packages/business/src/zalo-account/group.service.ts:99-127`). The business
test covers sync ordering, disabled send, and provider-ID/inbox scoping
(`packages/business/__tests__/zalo-account-group.service.test.ts:50-123`).

The gateway adapter sends with `ThreadType.Group` and discovers bounded group
metadata (`apps/zalo-account-gateway/src/runtime/zca-client.ts:132-177`). This
does not amount to group administration: the phase explicitly excludes member
persistence, group creation, moderation, bulk/all-group send, and a generic
group framework (`plans/261120-0350-zalo-account-channel-messaging/phase-08-group-control.md:18-29`).
There is also no persisted group send echo/message row, because group activity
is refresh-only.

**Recommended extension:** reuse the existing group service/repository and
fenced `sendGroupAndWait` transport for each newly approved operation. Add a
new typed command/result and idempotency behavior before exposing it; do not
turn the policy boolean into an implicit admin permission or a broadcast
primitive.

### 12 — native labels and ChatbotX tags

The implemented sync uses an account-scoped `TagChannel` with
`channelType=zaloAccount` and `integrationId=accountId`
(`packages/business/src/zalo-account/label.service.ts:89-115`). It filters
provider conversation IDs against locally known group provider IDs before
resolving direct `ContactInbox` rows (`:46-69`; sync assembly at `:205-231`).
The worker dispatches Zalo Account label sync to this service
(`apps/worker/src/default/handlers/sync-channel-labels.ts:71-77`), and generic
tag attach dispatches account-owned direct rows through
`mutateAssignment` (`apps/worker/src/default/handlers/sync-tag.ts:192-234`).
Tests cover empty-snapshot non-destructive behavior, direct-only mapping,
preservation of unrelated labels, and one verified version conflict retry
(`packages/business/__tests__/zalo-account-label.service.test.ts:106-243`).

Version regressions are guarded at two layers: the runtime returns its latest
cached snapshot when a provider response regresses
(`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:174-183`), and
the transport rejects a Redis accepted-version regression
(`packages/business/src/zalo-account/transport.service.ts:333-363,499-513`).
However, `zaloAccountLabelService.sync` treats any non-empty schema-valid
snapshot as complete and deletes local mappings whose IDs are absent
(`packages/business/src/zalo-account/label.service.ts:205-253`). There is no
provider completeness flag, page-count/continuation proof, or durable
“mutation disabled after uncertain write” state in this path. A non-empty but
partial/rate-limited provider result can therefore still cause a destructive
diff. The existing plan requires partial snapshots to be non-destructive and
mutation to disable when conflict evidence is unreliable
(`phase-09-native-labels-and-tags.md:18-27,33-43`); current code is short of
that stronger contract.

**Recommended extension:** keep `TagChannel` and direct `ContactInbox`
resolution. Add a complete-snapshot proof and accepted-version/uncertainty
state around the existing service. Treat unknown completeness as read-only;
never “solve” group labels by creating a ContactInbox.

### 13 — lifecycle, status, reaction, typing, undo, and delete

The SDK currently defines lifecycle events (`qr_generated`, `qr_scanned`,
`connected`, `closed`, and `reauthorization_required`)
(`packages/sdk/src/lib/zalo-account.ts:38-69`) and direct message/status/undo
schemas (`:149-193`). The gateway listener handles message, seen, delivered,
undo, and closed events (`apps/zalo-account-gateway/src/runtime/zca-client.ts:48-109`);
it intentionally returns immediately for group undo (`:90-93`). Ports expose
only direct message/status/undo and group activity—there are no reaction or
typing callbacks (`apps/zalo-account-gateway/src/runtime/ports.ts:37-112`).

Direct status and undo are wired into canonical worker jobs with account-scoped
IDs (`apps/worker/src/events/zalo-account/handler.ts:115-163`). The generic
received-message, status, and delete handlers have explicit Zalo Account route
resolution (`apps/worker/src/integration/handlers/received-message.ts:340-395`,
`apps/worker/src/integration/handlers/message-status.ts:67-100`,
`apps/worker/src/integration/handlers/incoming-message-change.ts:206-235`).
That is the implemented direct delivered/read/undo/delete slice.

The lifecycle gap is different: the runtime publishes account lifecycle events
(`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:383-433,435-489,573-590`),
but `handleZaloAccountEvents` handles lifecycle only when the route is a
`connect_session` (QR scan/authorization); the account-route branch covers only
direct message/status/undo and group activity
(`apps/worker/src/events/zalo-account/handler.ts:37-81,83-195`). No account-route
lifecycle branch updates the durable `Connection` status/reason. This can leave
the builder’s connection state stale after a passive close or reauthorization
event even though the gateway knows the state.

There are no `reaction` or `typing` event kinds in the transport union
(`packages/sdk/src/lib/zalo-account.ts:493-574`), no listener callbacks, and no
Zalo Account public/API/UI operation. Group undo/delete is not persisted because
group activity never creates a canonical message.

**Recommended extension:** for durable state, add an idempotent account-route
lifecycle consumer that maps connected/closed/reauthorization to the existing
Connection state service. For reactions, extend the SDK union, adapter, runtime
sink, worker event routing, and generic reaction handler only after a group
message identity exists. Treat typing as ephemeral realtime state, not a DB
message. Add direct/group delete semantics separately; do not silently reuse a
direct `messageId` for a group event.

### 14 — public API

The public router is already registered (`apps/builder/src/routers/public.ts:132-158`)
and exposes account list/get plus group list/get/sync, label sync, policy update,
and group message send (`apps/builder/src/features/zalo-accounts/api/public.ts:45-265`).
All use the `channels` workspace-token scope (`:22-22`), and the group service
re-checks workspace/account ownership. Public API tests cover safe account
metadata, scoped group list, policy update, send, and label sync
(`apps/builder/__tests__/zalo-accounts-public-api.test.ts:64-185`). The public
spec snapshot and MCP metadata tests include the operations, including outbound
HITL treatment for `zaloAccounts.sendGroupMessage`
(`apps/builder/__tests__/public-spec-mcp.test.ts:201-209,265-303`).

There are no procedures for group conversation list/get, group messages,
participants, reactions, typing, history, or account lifecycle status. The API
is complete only for the resource contract documented at
`docs/zalo-account.md:128-137`.

**Recommended extension:** add each new Full Group Inbox capability to the
public router first, reuse the business service, and then generate the spec
surface consumed by all clients. Keep read versus outbound/destructive HITL
metadata explicit.

### 15 — CLI and MCP

The CLI README documents current account/group/label commands
(`apps/cli/README.md:1633-1653`). The CLI loads the server’s
`/public-spec.json` dynamically (`apps/cli/src/openapi-loader.ts:425-491`) and
has explicit name overrides for the two sync subpaths
(`:276-287`), covered by tests (`apps/cli/__tests__/openapi-loader-command-names.test.ts:180-194`).

The MCP server likewise builds dynamic tools from the OpenAPI document rather
than maintaining a separate Zalo router (`apps/mcp-server/src/openapi-loader.ts:484-525`);
tool visibility and token-scope filtering are applied from the spec
(`:571-585`). The builder MCP tests require scope metadata on every
workspace-token operation and include group send in the outbound set
(`apps/builder/__tests__/public-spec-mcp.test.ts:201-209,265-303`).

Thus current CLI/MCP parity is real for group-resource operations. It cannot
cover Full Group Inbox, reactions, typing, group undo/delete, or lifecycle
status because those public operations do not exist.

**Recommended extension:** extend the public spec and let both loaders consume
it. Add a CLI name override only when the generated name collides or loses the
intended verb; add MCP `x-mcp` scope/HITL metadata in the public operation and
update the existing spec tests.

### 16 — builder UI

The settings page proves the current UI scope: it loads connected accounts,
connection state, and group resources, then passes them to the management
component (`apps/builder/src/app/space/[workspaceId]/(settings)/settings/channels/zaloAccount/page.tsx:21-57`).
The management view supports connect/reconnect/disconnect and renders the group
resource table (`apps/builder/src/features/zalo-accounts/components/zalo-account-manage.tsx:70-149`).
The group component provides sync groups, sync labels, a policy switch, and one
text test send, disabling controls for inaccessible/disabled groups
(`apps/builder/src/features/zalo-accounts/components/zalo-account-groups.tsx:31-100,102-181`).
The resource schema contains metadata/policy/sync timestamps only and no
messages or members (`apps/builder/src/features/zalo-accounts/schema/resource.ts:19-39`).

The group component refreshes the RSC page after mutations rather than
invalidating a dedicated group query (`:43-56,115-128`). That is adequate for
the current server-loaded settings page, but it is not a group conversation
cache or realtime Inbox surface. There is no route/component for group thread
history, participants, reactions, typing, or group message updates.

**Recommended extension:** keep the settings table as the resource-control
surface. Add a dedicated group read/query contract and invalidator only after a
group-thread data model exists; then add a separate Inbox/thread surface with
realtime subscriptions and i18n strings rather than embedding conversation
state in the settings card.

## Already built versus still absent

| Already built and verified in source | Still absent from the current tree |
|---|---|
| Account-scoped group metadata table with unique `(accountId, providerGroupId)`, indexed FKs, accessibility, sync generation, and disabled-by-default send policy (`packages/database/src/schema/integration-zalo-account.ts:53-88`). | Full group Inbox conversation/thread/history model; group messages are never saved as canonical `Message` rows. |
| Gateway discovery/detail and `ThreadType.Group` send (`apps/zalo-account-gateway/src/runtime/zca-client.ts:132-177`). | Group participants/member identity, membership history, moderation, group creation, and bulk send. |
| Coalesced group activity refresh with a test proving no direct/audience handler (`apps/worker/src/events/zalo-account/handler.ts:165-183`; `apps/worker/__tests__/zalo-account-events.test.ts:268-316`). | Group reactions, typing, group undo/delete, and group realtime message events. |
| Native label sync through account-scoped `TagChannel`, direct-only assignments, and provider-first label mutation (`packages/business/src/zalo-account/label.service.ts:89-115,195-337`). | Complete-snapshot proof and durable mutation-disabled handling for partial/ambiguous label writes. |
| Direct text/image/file message path, delivered/read status, and direct undo/delete (`packages/sdk/src/lib/zalo-account.ts:149-193`; `apps/worker/src/events/zalo-account/handler.ts:83-163`). | Durable handling of account-route lifecycle events after the gateway publishes them. |
| Public router, generated public spec, CLI command surface, dynamic MCP tools, and settings controls (`apps/builder/src/features/zalo-accounts/api/public.ts:45-265`; `apps/cli/README.md:1633-1653`; `apps/mcp-server/src/openapi-loader.ts:484-525`). | Public/CLI/MCP/UI operations for Full Group Inbox and the missing event types. |

## Migration and data risks

1. **Migration approval is still a rollout gate.** The group migration creates
   the table, indexes, and workspace/account cascade FKs
   (`packages/database/drizzle/20261120060156_zalo-account-groups/migration.sql:1-23`).
   The channel document explicitly says both Zalo migrations are generated but
   intentionally not applied and require explicit approval
   (`docs/zalo-account.md:161-171`). Do not treat unit tests or a schema snapshot
   as proof that a live database is ready.

2. **Do not retrofit group IDs into contact tables.** Existing ContactInbox,
   Conversation, Message, contact filters, labels, automations, analytics, and
   audience handlers all carry direct-contact assumptions. A synthetic Contact
   would make group activity visible to the wrong downstream systems and would
   violate the phase-08 zero-row safety contract.

3. **Group history needs its own retention and idempotency.** The current group
   event carries only provider group/message IDs and is immediately reduced to a
   refresh job. There is no persisted group-message dedupe ledger, message body,
   participant identity, or retention policy. Adding a group message table must
   define stable uniqueness, bounded workspace purge, attachment handling, and
   realtime replay behavior before exposing Inbox reads.

4. **Sync completeness is a data-integrity boundary.** The gateway currently
   takes at most the first 1,000 provider group IDs (`apps/zalo-account-gateway/src/runtime/zca-client.ts:132-155`),
   while `finishCompleteSync` tombstones every row outside the sync run
   (`packages/database/src/repositories/integration-zalo-account/group-repository.ts:94-117`).
   The service test proves ordering, not provider pagination/completeness. A
   partial or rate-limited result could make valid groups inaccessible and turn
   off sending. The same class of risk exists for a non-empty partial label
   snapshot (`packages/business/src/zalo-account/label.service.ts:218-253`).

5. **Policy and send outcomes must remain fenced/idempotent.** Current send
   requires a stable command ID and a gateway lease target through the transport,
   but adding group history/echo or admin actions must not replay an ambiguous
   provider outcome. Keep the existing `pending/applied/unknown` command result
   semantics and make any new group operation explicit.

6. **Connection state can drift.** The gateway emits `closed` and
   `reauthorization_required`, but account-route worker handling does not persist
   those events. Builder connection status may therefore be stale after a
   passive close or reauthorization until another command/reconnect path updates
   it. Add idempotent lifecycle consumption before relying on UI status for
   group send availability.

7. **Provider behavior is an operational risk.** The channel uses the unofficial
   `zca-js` protocol, whose behavior/account restrictions can change without
   notice (`docs/zalo-account.md:3-9`). Group Inbox rollout needs bounded staging
   fixtures for real provider payloads before enabling any new event or history
   path.

## Sequential TDD seams and commands

These are proposed seams, not commands run in this audit. Use one command at a
time and keep `VITEST_MAX_WORKERS=1`; apply the database migration only after
explicit approval.

### First: contracts and gateway normalization

1. Extend SDK schemas/event union and add RED tests for lifecycle persistence,
   reaction, typing, group undo/delete, and complete/partial group payloads:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-transport.test.ts
   ```

2. Add provider fixtures and listener tests for the new events while preserving
   the existing direct/group discriminator:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-message.test.ts __tests__/zalo-account-runtime.test.ts
   ```

### Second: business/data safety

3. Prove group resource sync/policy/send behavior, then add tests for provider
   pagination/completeness and tombstone safety:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-group.service.test.ts __tests__/zalo-account-transport.service.test.ts
   ```

4. Extend label tests with a non-empty partial snapshot, duplicate IDs,
   provider completeness failure, stale write/unknown outcome, and mutation
   disabled state. Keep direct-only/group-exclusion tests:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-label.service.test.ts
   ```

5. If Full Group Inbox is approved, add the separate group thread/message/member
   repository tests before touching the existing ContactInbox/Conversation path.
   Include provider-message dedupe, participant identity, retention, bounded
   purge, and no-contact-contamination assertions.

### Third: worker event and lifecycle routing

6. Add account-route lifecycle tests and reaction/typing/group undo/delete tests
   alongside the existing direct/group routing assertions:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
   ```

7. Add an integration-level test proving direct status/undo remains unchanged
   and group events do not enter `received-message` or `channel-audience-event`:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run __tests__/message.test.ts
   ```

### Fourth: public/API/client parity

8. Extend public procedures first, then test scope, idempotency, HITL metadata,
   and no secret projection:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-accounts-public-api.test.ts __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts
   ```

9. Verify generated CLI names and dynamic MCP discovery after the spec changes:

   ```bash
   VITEST_MAX_WORKERS=1 pnpm --filter chatbotx exec vitest run __tests__/openapi-loader-command-names.test.ts
   ```

### Fifth: database rollout gate

10. Only after explicit approval, inspect/apply the generated migrations in order
    and run the database integration suite; the current channel docs explicitly
    prohibit treating this as an automatic implementation step:

    ```bash
    VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/integration/zalo-account.test.ts
    ```

## Limitations

- No live Zalo account, provider payload capture, gateway process, Redis, or
  PostgreSQL state was inspected. Provider pagination/completeness and event
  field names therefore need staging fixtures before implementation.
- No tests or migrations were run, by the planning-only constraint.
- CLI/MCP parity is established from the dynamic OpenAPI loaders and public-spec
  tests, not from a live CLI/MCP session.
- This report does not choose the product semantics of a Full Group Inbox
  (participant identity, moderation, retention, assignment, automation, and
  analytics). Those choices affect the new data model and should be accepted in
  a separate plan before implementation.
