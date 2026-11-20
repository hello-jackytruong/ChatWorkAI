# Zalo Account items 5–9: architecture scout

Date: 2026-11-20
Scope: read-only repository research for a TDD plan; no product code was changed and no test/build/lint/typecheck command was run.

## Executive conclusion

The inferred mapping is directionally correct, but items 6–9 need narrower boundaries:

| Item | Repository-confirmed meaning | Correction for the plan |
| --- | --- | --- |
| 5. Fenced internal gateway command/event transport | Bind the foundation gateway runtime ports to a durable, typed command/event path, with workspace/account identity plus epoch/fence validation. | Do not use the realtime stream or send gateway events directly to the database. Normalize accepted provider events into the existing integration-job contract. |
| 6. Channel registration/connect + Inbox | Add the channel type/capability, connection adapter, channel-registry integration, specialized encrypted-auth lookup/context, Inbox visibility, public connect/session behavior, and teardown. | This is substantially more than adding a QR button. `zaloAccount` is currently a connection-registry placeholder and is intentionally absent from the generic integration registry. |
| 7. Inbound/outbound message mapping | Map gateway/provider events to the SDK message/contact model and route them through the existing integration worker and chat send pipeline, including echo/deduplication. | The provider parser is only one part. The identifier used by the worker to resolve the specialized account row must be chosen and tested. |
| 8. Group conversation control | There is an existing audience-event contract for group membership/group messages, but no generic Inbox group-conversation model. | Clarify the product meaning before implementation. Do not map group events to `incomingMessage` or call generic responder thread-control “group support.” Audience-only support is a safe minimal boundary; true Inbox groups require a separate data/identity design. |
| 9. Provider tags/labels sync/actions | Reuse `Tag`, `TagChannel`, contact-tag links, normalized inbox-label events, and the existing tag sync jobs. | First prove that the unofficial `zca-js` protocol exposes labels/tags. Existing Zalo OA tag endpoints are not evidence that Zalo Account supports them. Do not add a speculative tag table or cursor. |

The foundation docs explicitly defer transport, visible channel/Inbox integration, messages, groups, and tags. The existing foundation row and binding are useful seams, but they do not make the channel operational by themselves.

## Foundation boundary and reusable seams

`docs/zalo-account.md` and the completed foundation plan (`plans/261119-1534-zalo-account-foundation/plan.md`, phases 1–4) establish these constraints:

- `zaloAccount` is an unofficial personal-account protocol. Only `apps/zalo-account-gateway` may load/use `zca-js` and own the WebSocket/session.
- `Connection` is the connection lifecycle source of truth; `IntegrationZaloAccount` stores the account profile and encrypted authorization.
- The gateway uses a Redis lease/fencing token and a process-local runtime epoch. A stale epoch/fence must not mutate connection state.
- The current runtime ports are in-process only. `apps/zalo-account-gateway/src/main.ts` constructs the command port and event sink; its event sink is deliberately a no-op with the comment that item 5 will bind durable command/event transport.
- Existing runtime events carry `runtime`, `epoch`, and `fenceToken`. QR/auth events include `qr_generated`, `qr_scanned`, and profile/auth completion events. Secrets and QR contents must not be logged or put in ordinary lifecycle messages.
- `packages/database/src/schema/integration-zalo-account.ts:18-49` already has `id`, `workspaceId`, `inboxId`, `zaloUid`, `name`, `avatarUrl`, `encryptedAuth`, and `sessionVerifiedAt`. It has a workspace index, a unique `inboxId`, a unique `(workspaceId,zaloUid)`, and workspace/inbox cascade foreign keys.
- `packages/business/src/zalo-account/service.ts:24-112` is the existing service seam for public metadata, internal runtime-secret loading/decryption, and saving auth/profile. `packages/business/src/zalo-account/auth.ts:9-45` binds the encrypted authorization to workspace and Inbox via AAD.
- `packages/business/src/connection/store-bindings-channels.ts:441-456` already declares a `zaloAccount` binding using `encryptedAuth`, the Zalo Account codec, `zaloUid` identity, the duplicate constraint, and `keep_row` disconnect behavior. This binding must be used rather than creating a second auth-storage path.

## Item 5 — fenced gateway transport

### Current transport contracts

The runtime boundary is currently local to the gateway. The command/event port types are in the gateway runtime code (see `apps/zalo-account-gateway/src/runtime` and `src/main.ts`); no durable consumer is wired yet.

The repository already has two different event substrates:

1. `packages/event-bus` / `BaseEventBus` uses validated payloads, Redis Streams, consumer groups, reclaim, and acknowledgement. This is the closest existing durable event primitive.
2. BullMQ integration jobs in `packages/worker-config/src/queues/integration/index.ts:49-150` provide retrying worker delivery. `IntegrationJobReceiveMessage` and `IntegrationJobReceiveMessageEcho` carry `{ integrationType, integrationIdentifier, payload }`.

The realtime Redis stream is for best-effort client delivery, not gateway commands. `docs/scaling-messaging.md`, `docs/request-workflow.md`, and ADR `docs/adr/0004-messaging-substrate-scaling-path.md` describe the current split: BullMQ for tier-1 work, Redis Streams for durable event buses, and realtime relay for client-facing delivery.

### Recommended narrow design

Use a typed, dedicated Redis-Streams command/event seam (or a small BaseEventBus-compatible module) for gateway control/lifecycle events, and enqueue normalized customer/provider events into the existing integration queue. This preserves durable ordering/replay and permits a gateway process that is not a normal worker. Do not reuse the realtime stream and do not make the gateway write Inbox/message rows directly.

Every command/event envelope should carry at least:

- `workspaceId`, `inboxId`, and the persisted Zalo Account/connection identifier;
- a provider/account route key;
- `runtime`, `epoch`, and `fenceToken` for fencing;
- a command/event id and provider event/message id where available, for idempotency;
- a non-secret event kind and typed payload.

The consumer that accepts a command or lifecycle transition must reject a stale epoch or fence before changing `ConnectSession`, `Connection`, or runtime state. Auth material/QR data should be restricted to the existing connect-session path; normal message/lifecycle events should not contain encrypted auth or raw credentials.

### Owning files and symbols

- `apps/zalo-account-gateway/src/main.ts` — runtime assembly; currently no-op event sink.
- `apps/zalo-account-gateway/src/runtime/*` — `RuntimeCommandPort`, `RuntimeEventSink`, lifecycle event types, epoch/fence fields.
- `apps/zalo-account-gateway/src/account-lease-store.ts` and `src/zalo-account-pool.ts` — lease ownership and single-runtime constraints.
- `packages/event-bus/src/event-bus.ts` (and exports in `packages/event-bus/src/index.ts`) — existing Redis Streams durability/consumer-group seam.
- `packages/worker-config/src/queues/integration/index.ts:49-150,1462-1470,1525-1600` — integration actions and receive/thread-control job data.
- `apps/worker/src/integration/worker.ts` — integration-job dispatch, including `incomingMessage`, echo, label, thread-control, and audience events.

The transport phase should finish when a command can reach the single owning gateway runtime and a fenced gateway event can reach the correct durable consumer. It should not implement all message/group/tag semantics in the transport layer.

## Item 6 — channel registration, connect, and Inbox integration

### Registration gaps

- `packages/database/src/partials/integration.ts:3-39` already includes `IntegrationType = "zaloAccount"`.
- `packages/utils/src/channel.ts:18-33` does **not** include `zaloAccount` in `channelTypes`. `CHANNEL_CAPABILITIES` at `:121-208` is an exhaustive `Record<ChannelType, ChannelCapability>`, so adding the type requires an explicit product decision for `creatable`, `manageable`, `requiresCredential`, `order`, and `callable`.
- `packages/connections/src/registry.ts:141-216` has `zaloAccount: null`. The existing generic connect flow (`apps/builder/src/features/connections/lib/connect-flow.ts:80-203`, `packages/connections/src/device-session-flow.ts:53-242`, `packages/connections/src/connect-session-flow.ts:307-420`) can supply the lifecycle shape, but a real adapter/provider is required.
- `packages/channel-registry/src/registry.ts:1-103` imports/exports all active integrations and `allIntegrations`; Zalo Account is absent. `integrationService.identifyInboxAndIntegrationAuthFromIdentifier` (`packages/channel-registry/src/registry.ts:117-241`) and `getIntegrationFromContactInbox` (`:243-343`) also have explicit integration/model maps with no Zalo Account entry.

The current builder connection picker (`apps/builder/src/features/channel-connect/lib/registry.ts:15-20,144-186`) is a small Meta-channel picker, so adding Zalo Account there is not automatic. It may be better exposed through the existing QR/device connect-session/public connection routes and a channel settings page, depending on the accepted UI. This is a product routing decision, not a reason to bypass the public connection API.

### Auth/context special case

The generic worker context path expects an `auth` field:

- `packages/database/src/repositories/integration-lookup/repository.ts:24-33` performs the generic identifier lookup and returns an `auth` column.
- `packages/business/src/integration-context/build-context.ts:108-133` passes `integration.auth` into `makeAuthStore` and `buildContextWithAuthStore`.
- Zalo Account stores `encryptedAuth`, deliberately not a plain `auth` column. `packages/database/src/repositories/integration-zalo-account/repository.ts:16-91` is the specialized row repository, and `packages/business/src/zalo-account/service.ts` is the decryption boundary.

Therefore item 6 must add a specialized lookup/decrypt/context path (or a carefully extended generic binding contract) for both worker inbound resolution and outbound send. Simply adding `zaloAccount` to a generic integration map would either yield no usable auth or expose the encrypted column to the wrong layer.

### Inbox/connect/teardown work

- `packages/connections/src/internal.ts:323-420` creates the Inbox using `toChannelType(provider)`, inserts a generic binding, and advances the Connection FSM. The adapter must make this produce the Zalo Account Inbox plus the satellite row, with the specialized binding and no secret in client projections.
- `packages/business/src/inbox/service.ts:70-87` currently excludes `integrationZaloAccount` from safe `withIntegrations` results because the channel is reserved and the row contains encrypted device authorization. Once the channel is visible/manageable, add a public-safe projection deliberately; never return `encryptedAuth`.
- `packages/business/src/workspace-lifecycle/service.ts:708-927` has explicit channel teardown cases. The Zalo OA case at `:786-801` deletes `tagChannel` and the Zalo row, but there is no Zalo Account case. Add an idempotent Zalo Account teardown that stops/fences the gateway before deleting or retaining the satellite row and cleans channel-scoped tags.
- `packages/business/src/inbox/connect-channel.ts:15-31` has a descriptor map for older channel-connect paths; inspect whether the chosen connect path uses it before adding a descriptor.
- `apps/builder/src/app/.../settings/channels` currently has no `zaloAccount` route. If `manageable: true`, add the route and use the existing channel visibility policy. `Tenant.hiddenChannels` is a UI gate, not authorization (`docs/agents/invariants.md`, invariant 18).

Public connect/session procedures already exist in `apps/builder/src/features/connections/api/public.ts` (connection list/create/reconnect/disconnect/refresh/verify and QR-device session descriptions around `:151-160` and router exports after `:320`). Extend these procedures through the existing connection service; do not create a UI-only connect path. The agent-first invariant requires the public API surface before UI, followed by the `cli-mcp-docs` skill.

## Item 7 — inbound and outbound message mapping

### Inbound path to reuse

The canonical path is:

```text
gateway provider event
  -> fenced transport consumer
  -> IntegrationJobReceiveMessage / ReceiveMessageEcho
  -> apps/worker/src/integration/worker.ts
  -> processIncomingMessage / received-message.receiveMessage
  -> integrationService identifier lookup + buildContext
  -> SDK message.receiveMessage parser
  -> contact/conversation/message persistence, automation, analytics, realtime
```

The important contracts are:

- `packages/worker-config/src/queues/integration/index.ts:132-150` defines the receive/echo job shape.
- `apps/worker/src/integration/handlers/received-message.ts:307-391` checks `allIntegrations`, resolves Inbox and integration row by `integrationIdentifier`, builds context, and invokes `runChannelHandler("message", "receiveMessage")`. A null parser result is intentionally dropped (`:383-391`).
- Contact/conversation identity resolution in `apps/worker/src/integration/handlers/received-message.ts:2443-2488,2562+` uses the SDK contact source identity and optional conversation/thread identifiers. `IncomingMessage.sourceId` is the provider message id and is used for dedup/echo bookkeeping.
- `packages/sdk/src/lib/shared/message.ts:32-86,208-226,504-528` defines `IncomingContact`, `OutgoingContact`, and `IncomingMessage`; `packages/sdk/src/lib/shared/index.ts:42-76` defines `ReceivedMessageResult`.

The Zalo OA adapter is the closest mapping example:

- `integrations/zalo/src/handlers/message/incoming-message/index.ts:50-85` uses sender id for a user message and recipient id for an OA echo, and creates the canonical contact source id.
- `:94-168` maps `msg_id`, direction, text/content type, attachments, and location.
- `integrations/zalo/src/handlers/message/outgoing-message/index.ts:39-71,138-152` sends text/media to the provider and addresses the recipient through `contact.sourceId`.
- `integrations/zalo/src/handlers/webhook.ts:106-243` shows the established split between incoming message, incoming echo, read, audience, and label events.

For Zalo Account, the provider adapter should produce the same SDK shape but must not copy OA semantics blindly. At minimum, pin and test these mappings:

- inbound contact `sourceId`: stable sender/user id for a 1:1 conversation;
- inbound message `sourceId`: provider message id;
- direction/message type: inbound user message versus the account’s own echo;
- `contact.channelConversationId`: provider chat/group id only when needed to address the provider conversation;
- `sourceConversationId`: reserved for provider thread/comment semantics, not a generic group id;
- attachments/media: provider-specific download/URL policy, with no raw session secret in payloads.

### Outbound path and route key

`apps/worker/src/chat/handlers/send-message.ts:227-242,300-439,495-517` resolves the source conversation, checks thread-control/send gates, resolves integration context, invokes the SDK `sendMessage` handler, and writes the provider source id back for deduplication/echo handling. A Zalo Account adapter needs `sendMessage` (and media behavior only if the protocol supports it), returning provider message ids and preserving the provider chat address.

The worker’s inbound lookup requires a stable `integrationIdentifier`. The specialized row is indexed by `zaloUid` and `id`; the plan must choose one route key and use it consistently in gateway events, label events, and send-context lookup. A practical default is `zaloUid` for provider-originated inbound events (it identifies the connected account and has a unique workspace index), while internal commands should use the persisted account/connection id. This is a design decision to lock in tests, not an assumption to leave implicit.

No direct gateway-to-DB message write is justified: it would bypass contact/conversation identity, deduplication, automation, analytics, and realtime/event-bus behavior already implemented in the worker pipeline.

## Item 8 — group conversation control (boundary correction)

The repository has three distinct concepts that must not be conflated:

1. **Group/audience events.** `packages/sdk/src/lib/shared/audience-event.ts:1-64` explicitly models `groupJoin`, `groupLeave`, `groupMessage`, and `botChatStatus` as events that do not represent a 1:1 conversation. `apps/worker/src/integration/handlers/channel-audience-event.ts:153-200` records only supported audience/leaderboard effects and does not create a conversation or run bot automation.
2. **Provider-specific group status.** `packages/database/src/schema/telegram-chat.ts:31-63` stores Telegram group status/picker data. It is not a generic group-conversation model and should not be reused for Zalo Account without matching semantics.
3. **Thread control/handover.** `packages/sdk/src/lib/integration.ts:269-377` and `packages/sdk/src/lib/shared/message.ts:253-501` define responder ownership/standby/handover. `apps/builder/src/features/conversations/api/public.ts:488-499` exposes take/release/pass operations. This controls who responds in an existing conversation; it does not provide group membership or multi-participant message identity.

Telegram proves the safety boundary: `integrations/telegram/src/handlers/webhook.ts:19-47,78-121,168-201` recognizes group events and intentionally keeps them out of `incomingMessage`; `integrations/telegram/__tests__/group-routing.test.ts` asserts that behavior.

The plan should select one of these explicit scopes:

- **Audience-only (minimal, safe):** map provider group join/leave/message/status events to `ChannelAudienceEvent`; no Inbox conversation, no automation, and no new group table unless a status/picker requirement is separately accepted.
- **True Inbox group conversations:** design a new provider/group identity contract first: stable group conversation id, participant/contact attribution, group metadata, send addressing, member changes, deduplication, authorization/moderation, and UI semantics. This likely needs a provider-specific table and broader worker/message model changes; it is not a small item-8 implementation.
- **DM responder handover:** implement SDK thread-control handlers only if Zalo Account has a real handover concept. Do not call this group support.

Until the user chooses, the minimal 5–9 plan should implement audience-only event routing or leave group Inbox support out. It must not feed a Zalo group message into the existing 1:1 `incomingMessage` path merely because the provider emits text.

## Item 9 — provider tags/labels

### Existing generic substrate

- `packages/database/src/schema/tag.ts:17-43` stores workspace tags.
- `packages/database/src/schema/tag-channel.ts:6-49` maps a local tag to a channel/integration and external label id, with uniqueness guards.
- `packages/database/src/schema/contact-to-tag.ts` and `contact-to-tag-channel.ts` store global and channel-scoped contact links.
- `packages/business/src/tag/sync.service.ts:10-223` enqueues create/attach/detach/delete/channel-scan operations.
- `apps/worker/src/integration/handlers/inbox_labels/types.ts:3-44` normalizes provider label payloads to `assign`, `unassign`, and `deleteLabel` events.
- `apps/worker/src/integration/handlers/inbox_labels/index.ts:10-64` is a channel registry with one adapter per channel; it currently has only Messenger and Zalo OA (`CHANNELS` at `:14-17`). Add a Zalo Account adapter only after the provider event shape is verified.
- `apps/worker/src/default/handlers/sync-channel-labels.ts:39-149` runs per-channel scans using the SDK label list/contact operations.
- `apps/worker/src/default/handlers/sync-tag.ts:40-117,171-304,311+` handles create/attach/detach/delete. The existing Zalo OA implementation uses provider tags by name and custom actions.
- `packages/sdk/src/lib/integration.ts:379-383,416-493,495-523` provides `ChannelLabel`, contact label assignment/removal, and bot label list/create/delete capabilities.

Zalo OA is not a drop-in implementation for a personal Zalo Account. `integrations/zalo/src/api/tag.ts:11-87` and `integrations/zalo/__tests__/tag.test.ts` target OA endpoints (`tagFollower`, `removeFollowerFromTag`, `listOaTags`, and user detail). The unofficial `zca-js` protocol must be inspected/verified for personal-account labels before defining an adapter. If it has no stable label API, item 9 should be explicitly unsupported rather than emulated with local-only tags.

If supported, prefer the existing `TagChannel` mapping and normalized label jobs. Enqueue a channel scan after connect using the same pattern as other integrations; add a sync cursor/provider-specific table only if the protocol demonstrably requires durable pagination/cursor state. Any new workspace child table must have a leading workspace index and an explicit bounded/idempotent purge plan.

## Schema, cascade, and invariant audit

1. **ChannelType cascade.** Adding `zaloAccount` to `packages/utils/src/channel.ts` requires updating every exhaustive `Record<ChannelType, ...>` and any semantic channel map. Relevant hits include:
   `apps/builder/src/features/{broadcasts,contacts,inboxes,messages,workspaces}`, `apps/worker/src/integration/handlers/inbox_labels/index.ts`, `packages/business/src/{broadcast,contact-sync,contact/profile-refresh,inbox,product-message}`, `packages/database/scripts/backfill-connections/channel-fetchers.ts`, `packages/flow-config/src/{channel-rules,nodes}` and `packages/utils/src/channel.ts`. The existing comment at `packages/utils/src/channel.ts:15-16` is an explicit instruction to audit these maps.
2. **Connection/integration exhaustiveness.** `packages/connections/src/registry.ts:141-216`, `packages/channel-registry/src/registry.ts:55-103`, integration lookup maps, and the SDK `IntegrationDefinition` must agree on the key. A null connection adapter or absent `allIntegrations` entry will fail at connect or worker dispatch.
3. **Encrypted auth projection.** Keep `encryptedAuth` out of public Inbox/integration model projections (`packages/database/src/types.ts:126-132` and the existing `inboxService` exclusion). Only `zalo-account` service/runtime code should decrypt it.
4. **Workspace purge.** The existing Zalo Account table has workspace/inbox cascade FKs and indexes, but `workspace-lifecycle/service.ts` still needs an explicit runtime stop/row/tag teardown branch. Follow `.agents/skills/workspace-purge/SKILL.md`: new child tables require a leading workspace index and bounded child-before-parent drains.
5. **Worker safety.** Integration jobs must use `withBlockedOwnerGuard`; logs use the pino logger and `{ err }` shape. Message/echo event handling must be idempotent by provider event/message id and must not retry events the parser intentionally drops.
6. **Agent-first API.** Connection/session, tag operations, and any supported group control must be public procedures first. The derived OpenAPI spec is what CLI/MCP consume; run `.agents/skills/cli-mcp-docs/SKILL.md` after implementation, not a hand-written CLI-only route.
7. **Migration safety.** No migration was applied or should be auto-applied as part of this research. The existing `IntegrationZaloAccount` migration/schema must remain drift-consistent; any new group/tag table requires a reviewed migration and purge/index audit.

## Existing tests and proposed sequential validation

The following are existing focused test locations to extend. They are listed as a proposed validation order only; none was run during this scout. Run each command separately (not in a parallel shell) with one Vitest worker:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/server.test.ts __tests__/account-lease-store.test.ts __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-pool.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/device-session-flow.test.ts __tests__/registry.test.ts __tests__/integration/connection-engine.test.ts __tests__/integration/connect-session-flow.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/integration/zalo-account.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account.service.test.ts __tests__/integration-inbox-lookup.test.ts __tests__/connection-store-bindings-jsonb-defaults.test.ts __tests__/integration/connection-store-bindings-insert.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo exec vitest run __tests__/tag.test.ts __tests__/outgoing-text-with-images.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/integration-worker-incoming-message.test.ts __tests__/received-message.test.ts __tests__/inbox-labels.test.ts __tests__/sync-channel-labels.test.ts __tests__/sync-tag.test.ts __tests__/sync-tag-create-attach.test.ts __tests__/channel-audience-event.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-telegram exec vitest run __tests__/group-routing.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/connections-public-api.test.ts __tests__/connections-private-api.test.ts __tests__/connect-session-message.test.ts __tests__/connect-channel-registry.test.ts __tests__/inboxes-public-api.test.ts
```

Some tests above are existing comparison tests rather than tests that should be copied wholesale. Add Zalo Account tests beside the owning package tests, and keep database-backed tests opt-in with the repository’s existing integration configuration. Before a final implementation run, verify the package filter names and test paths against the current package manifests; this report intentionally does not execute them.

## Minimal phase boundary for items 5–9

### Phase 5 — durable fenced transport

- Define typed command/event envelopes and event kinds needed by connect, stop/reconnect, inbound/outbound message, and later label/group events.
- Bind `RuntimeCommandPort`/`RuntimeEventSink` in the gateway to the durable transport.
- Enforce epoch/fence checks before runtime or connection-state transitions; test stale/duplicate/reordered deliveries.
- Deliver normalized provider events to the existing integration-job seam. Do not add message/group/tag business behavior here.

### Phase 6 — connection and Inbox registration

- Add `zaloAccount` to channel capabilities and all required exhaustive maps, with an explicit visibility/connectability decision.
- Replace `CONNECTION_REGISTRY.zaloAccount: null` with the device-session adapter and register an integration definition/context path.
- Add specialized account-row lookup/decrypt/auth-store wiring for inbound and outbound paths; preserve secret projections.
- Complete Inbox/Connection/satellite-row creation, QR/session public routes, safe Inbox metadata, visible settings (if accepted), and idempotent workspace/channel teardown.

### Phase 7 — 1:1 message mapping

- Implement gateway-to-job normalization and the Zalo Account SDK adapter for receive/send/profile/media capabilities actually supported by `zca-js`.
- Pin the worker `integrationIdentifier` route key and source-id semantics; cover inbound, own echo, duplicate/retry, unsupported payload, and outbound provider-id update.
- Reuse the canonical worker pipeline; no direct DB writes from gateway.

### Phase 8 — group decision and control

- First record the product decision: audience-only, true Inbox group conversations, or DM handover.
- For audience-only, add only the provider adapter to `ChannelAudienceEvent` and any necessary status persistence.
- Keep true Inbox group support outside the minimal implementation until group identity, participant model, sending, and migration/purge requirements are accepted. Do not implement it by weakening the 1:1 message assumptions.

### Phase 9 — tags/labels

- Verify the personal-account provider’s label API/event payloads and supported operations.
- If supported, implement the SDK capability and `inbox_labels` channel adapter, then reuse `TagChannel`, contact-tag links, scan, and sync jobs.
- If unsupported, expose the capability as unsupported and leave local tag behavior explicit; do not pretend OA tags work for personal accounts.
- Add provider-specific persistence only if a demonstrated cursor/rate-limit requirement needs it, with migration, workspace index, purge, and tests.

## Risks and unresolved decisions

- **Protocol risk:** `zca-js` is an unofficial dependency. Its event/message/group/tag surface may change or omit OA features. Keep provider-specific code behind the gateway/SDK adapter seams and test payload validation.
- **Fencing risk:** a stale runtime can emit a valid-looking message after reconnect. The transport consumer and downstream message idempotency must reject stale account epoch/fence, not rely only on the gateway’s local lease.
- **Route-key risk:** using `zaloUid`, account id, or Inbox id inconsistently will make worker lookup fail or route one account’s event to another. Lock the choice in a typed event contract and tests.
- **Group semantics risk:** group messages may create a contact/conversation explosion or run automation unexpectedly. Preserve the existing audience-event boundary until product semantics are explicit.
- **Label semantics risk:** Zalo OA tags are not evidence for Zalo Account tags. Confirm capability before promising item 9.
- **Lifecycle risk:** `keep_row` binding behavior and gateway stop ordering must be reconciled with disconnect, reconnect, workspace purge, and lease expiry; do not leave a live runtime holding an authorization row after teardown.

This scout did not inspect external `zca-js` documentation or run live provider traffic; those are the remaining sources of truth for the group and label capabilities. It also did not select UI wording/order or decide whether Zalo Account is creatable/manageable in the channel picker; those are product decisions after the backend contracts above are fixed.

Status: DONE
Summary: Confirmed the item 5–9 mapping, traced the existing gateway/connection/worker/tag contracts, and identified the required encrypted-auth and ChannelType cascades. Corrected item 8: generic group Inbox support is not present and must be an explicit product/data decision; the minimal safe scope is audience events only.
Concerns/Blockers: Personal-account `zca-js` support for group conversations and provider labels was not verified from live provider documentation/traffic, so items 8 and 9 require capability confirmation before implementation.
