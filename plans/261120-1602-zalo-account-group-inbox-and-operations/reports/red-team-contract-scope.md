# Red-team contract and scope review

Scope reviewed: `plan.md` and phases 10–16, with emphasis on `Contact.kind`, SDK events, realtime typing, public API/CLI/MCP parity, group policy, and file ownership. This is a planning review only; no build, lint, test, install, or generation command was run.

## Findings

### HIGH — Canonical outbound chat paths still have unconditional customer side effects

The plan requires group persistence to be side-effect-free and explicitly excludes contact/MAC/leaderboard/customer effects (`phase-10-full-group-inbox.md:25-27`), while API direct/group sends must use the canonical persisted Message/chat path (`phase-14-public-api-cli-mcp.md:26-33`). The current canonical paths are not side-effect-free: `send-message` records outbound/delivery/service activity and auto-unblocks the contact after dispatch (`apps/worker/src/chat/handlers/send-message.ts:560-612`), and flow sends perform the same bookkeeping plus human/bot analytics (`apps/worker/src/chat/handlers/send-flow-step.ts:1607-1645`). The Zalo integration entry point currently sends direct messages using the contact source identity (`integrations/zalo-account/src/message.ts:114-156`).

Adding a reserved group-conversation branch only in the integration file cannot satisfy the plan: group sends through Inbox, flow, public API, CLI, or MCP would still traverse the worker bookkeeping unless those consumers are explicitly fenced. The phase file lists the integration and dedicated group service, but not the shared outbound bookkeeping/analytics boundary (`phase-10-full-group-inbox.md:35-38`). Require an explicit group side-effect policy and ownership for `send-message`, `send-flow-step`, contact-inbox delivery bookkeeping, and analytics/automation consumers, with tests for both Inbox and flow sends.

### HIGH — Realtime typing has no compatible delivery, routing, or consumer contract

Phase 13 requires actor UID/name and expiry semantics for ephemeral typing (`phase-13-advanced-message-lifecycle.md:20-22`), and Phase 15 requires the builder Inbox to display the actor and expiry (`phase-15-admin-ui-and-inbox.md:27-34`). The existing protocol payload is only `{ conversationId, typing, seconds }` (`packages/realtime-protocol/src/schemas.ts:293-300`), and `typing` is classified as a workspace-delivery event rather than a conversation-routed event (`packages/realtime-protocol/src/schemas.ts:29-52`). Workspace event dispatch is listener-based (`apps/builder/src/features/realtime/workspace-realtime-provider.tsx:151-196`); the chat realtime consumer has no typing handler (`apps/builder/src/features/chat/chat-realtime.tsx:215-299`), while guest webchat separately expects `{ typing: boolean }` (`apps/builder/src/features/integration-webchat/webchat-realtime.tsx:61-85`).

The plan’s “typing payload extension and builder consumption” wording (`phase-13-advanced-message-lifecycle.md:35-38`) does not define whether typing remains workspace-broadcast, gains a conversation route, or becomes a discriminated direct/group/guest payload. Implementing actor fields without that contract can leak group typing to unrelated workspace listeners and/or break the guest shape. Require an explicit protocol compatibility matrix (delivery class, route, direct/group/guest payloads, expiry) and name the protocol, builder provider, chat consumer, and guest consumer changes before implementation.

### HIGH — `Contact.kind` is not closed at the public Contact contract and write boundaries

The plan correctly requires a real `person` default and person-only repository/service behavior (`phase-10-full-group-inbox.md:18-19`, `:38`, `:55-61`), but the listed ownership stops at database/business consumers and does not name the public Contact projection or its CRUD callers. The builder resource is generated directly from the database contact model (`apps/builder/src/features/contacts/schema/resource.ts:7-11`), and public list/count/get/create/update/delete routes all call generic contact service entry points (`apps/builder/src/features/contacts/api/public/crud.ts:56-175`, `:177-333`). Those service/repository methods currently accept workspace-scoped contacts without a kind predicate, including detail/lookup/writer/delete/quota paths (`packages/business/src/contact/service.ts:305-315`, `:424-463`, `:762-907`, `:953-1068`; `packages/database/src/repositories/contact/repository.ts:165-220`, `:401-434`).

Consequently, a repository-only “default person” change can still expose a group anchor through `contacts.get`, allow generic updates/deletes to target it, and automatically add `kind` to the public resource without an intentional API contract. Require the phase to name the public resource/API files and define the behavior for list/detail/export/create/update/delete (person-only not-found vs. an explicit group service), then enumerate every direct repository caller before migration approval. The existing plan’s generic “mandatory entrypoints” wording is not enough to prove these public consumers are covered.

### MEDIUM — Adding `group_message` leaves the existing `group_activity` consumer contract ambiguous

Phase 10 introduces a separate `group_message` SDK/event schema and dedicated worker handler (`phase-10-full-group-inbox.md:21-23`, `:32-36`, `:57-60`), while also saying the direct event branch remains unchanged (`phase-10-full-group-inbox.md:65-66`). The current SDK transport union still contains `group_activity` (`packages/sdk/src/lib/zalo-account.ts:493-574`); the gateway publishes it (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:513-571`, `apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts:216`, `:309`), and the worker’s only current group event branch queues group refresh (`apps/worker/src/events/zalo-account/handler.ts:165-183`).

The plan does not state whether `group_activity` is retained for refresh, replaced by `group_message`, or emitted alongside it. Replacing it silently stops the existing refresh consumer; emitting both can duplicate refresh work for every group message. Add an event compatibility table and explicit fan-out/retirement ownership for the SDK union, gateway publisher, and worker handler, including reconnect and old-gateway overlap behavior.

### MEDIUM — Generated CLI/MCP naming parity needs a route-level contract for account vs. group policy

Phase 11/14 require an account kill switch plus per-group receive/send/automation policy and generated CLI/MCP parity (`phase-11-group-controls.md:18-26`; `phase-14-public-api-cli-mcp.md:26-33`, `:51-65`). CLI names are derived from the OpenAPI path/method (`apps/cli/src/openapi-loader.ts:327-368`), generic collisions silently drop the losing operation (`apps/cli/src/openapi-loader.ts:185-190`), and the existing Zalo overrides already include collision workarounds (`apps/cli/src/openapi-loader.ts:192-278`). The CLI README documents that collision behavior (`apps/cli/README.md:1668-1685`); MCP likewise deduplicates derived tool names and keeps the first operation (`apps/mcp-server/src/openapi-loader.ts:402-420`, `:455-480`).

If the new account kill switch is exposed as a sibling policy PATCH to the existing group-policy PATCH, generated names can collide unless the route or an explicit override is reserved. “Resolve any CLI command collision” (`phase-14-public-api-cli-mcp.md:61-65`) is an acceptance note, not a contract. Require operationId-to-CLI/MCP names (or exact paths plus override entries) in the phase before public API implementation, with a test proving both policy mutations remain discoverable and distinct.

## Status

Status: DONE

Summary: Found five high/medium contract gaps: outbound group side effects, realtime typing compatibility, Contact.kind public/write boundaries, SDK group-event compatibility, and generated policy command naming. The report is capped at five findings and cites plan/source locations.

Concerns/Blockers: None for this planning-only review.
