---
phase: 14
title: "Public API, CLI, and MCP parity"
status: completed
priority: P1
effort: "L"
dependencies: ["Phases 11–13"]
---

# Phase 14: Public API, CLI, and MCP parity

## Execution status

Implementation and static verification passed on 2026-11-21. Scoped public API sends/sync/tags and built CLI/MCP status calls passed against the approved staging API. MCP semantic discovery and exact tool-name discovery returned the correct status tool. Client checks used a temporary loopback TLS bridge for staging's FORCE_PUBLIC_HTTPS setting; no public API allowlist was widened. Evidence and limits: private staging records (not included in this repository).

## Goal

Expose every supported Zalo Account operation as a scoped public procedure first, with generated CLI/MCP parity and the private UI calling the same business services.

## Public capability map

### Reuse existing operations

- QR connect/poll: `connections.create` + `connectSessions.get` with provider `zaloAccount`.
- Reconnect/disconnect: existing connection procedures.
- Account list/get and group list/get/sync, label sync, group policy, and group send: preserve existing paths and response compatibility.

### Add/extend operations

- Safe account health/status, group kill-switch state, last friend/group/label sync status, and reconnect reason; no auth/cookie/IMEI/user-agent data.
- `syncFriends`: normalize the provider friend list and fill/upsert direct `person` Contacts/ContactInbox rows in bounded chunks through an adapted existing import path plus the durable quota ledger below, without MAC/customer-created activity or destructive deletion on partial sync.
- Group policy fields: receive, send, automation mode; list/filter allowlisted groups.
- Direct send by known provider UID/contact inbox and group send by group resource, both through canonical persisted outbound Message/chat paths; text, one image/file, and same-thread reply only. Persist an outbound attempt (`pending | sent | unknown | failed`) with command/client-message ID before dispatch; a later self echo/provider response reconciles `unknown` idempotently and automatic replay stays blocked.
- Manual native-label reconciliation/status.
- Supported reaction/revoke/delete operations only where Phase 13 marks capability available; typing remains a conversation operation, not a durable resource.

### Policy naming contract

- Account kill switch: `PATCH /connections/zalo-account/{accountId}/group-messaging`, operationId `zaloAccountSetGroupMessaging`, CLI `zalo-account-set-group-messaging`, MCP `zalo_account_set_group_messaging`.
- Group policy: `PATCH /connections/zalo-account/{accountId}/groups/{groupId}/policy`, operationId `zaloAccountUpdateGroupPolicy`, CLI `zalo-account-update-group-policy`, MCP `zalo_account_update_group_policy`.
- Assert these names against both current OpenAPI loaders before adding the routes. If the loader cannot derive them uniquely, add explicit loader overrides with collision tests; do not rely on first-operation-wins dedupe.

Public mutations require `channels` scope plus existing read-only/HITL semantics. Settings-only private mutations (sync, reconciliation, kill switch, group policy) independently enforce the same `superAdmin` workspace permission as the settings route; Inbox send uses the existing conversation-send permission. Caller-supplied command IDs remain mandatory for provider-side effects.

## Friend-sync boundary

Add a typed `sync_friends` gateway command/result with only UID, display name, safe avatar metadata, and explicit completeness/cursor status. Add a `zaloAccount` UID identity adapter and process bounded chunks sequentially. A durable import/outbox ledger couples each newly created `person` row to exactly-once quota/workspace-usage accounting and crash-safe replay; no MAC/customer-created analytics are emitted. Missing friends are not deleted or unsubscribed unless a future complete-snapshot product decision explicitly authorizes it.

## Files to modify/create

- `apps/builder/src/features/zalo-accounts/api/public.ts`, resource schemas, public router/spec tests, and thin private actions/query adapters.
- `packages/business/src/zalo-account` services and gateway transport command schemas/executor for friend sync/status.
- `apps/cli` naming collision tests/README only where generated names require it.
- `apps/mcp-server/README.md` only if default visibility changes; MCP runtime remains OpenAPI-driven.
- `docs/zalo-account.md` and external agent-distribution docs noted by `cli-mcp-docs` when available.

## TDD sequence

### RED

1. Every UI-capable operation appears in the public spec with unique operationId, scope metadata, machine-usable outputs, and POST/PATCH for side effects; both policy mutations resolve to the distinct CLI/MCP names above.
2. Cross-workspace/account/group/contact IDs return scoped not-found/forbidden behavior before provider calls; a normal member cannot call settings-only private actions directly, while authorized Inbox send still works.
3. Safe projections omit encrypted auth, cookies, IMEI, user agent, QR secrets, lease owner, and raw provider payloads.
4. Direct/group send produces a canonical Message/attempt and uses the same service as the private path; provider-accepted-then-timeout reconciles from self echo, while disconnect-before-provider-call is `failed`, not `unknown`.
5. Friend sync creates/updates only `person` rows through the Zalo Account UID adapter, is bounded/idempotent, makes quota accounting crash-recoverable without double count, skips MAC/customer-created effects, and is non-destructive on partial results.
6. CLI derived names do not collide; MCP outbound/destructive operations require confirmation/HITL metadata.
7. Existing Zalo Account and Zalo OA public tests remain green.

### GREEN

1. Add/extend public procedures before private UI actions.
2. Route every handler to the Phase 10–13 business service; app code imports no DB client.
3. Add typed friend sync transport/service, UID identity adapter, durable created-row/quota accounting ledger, and safe status projection.
4. Update OpenAPI descriptions so an agent can discover IDs, policy prerequisites, unknown outcomes, and retry restrictions without UI context.
5. Run the `cli-mcp-docs` checks, resolve any CLI command collision, and update only applicable README/docs surfaces.

### REFACTOR

- Keep lifecycle orchestration under connections APIs rather than duplicate Zalo-only QR/reconnect implementations.
- Keep CLI/MCP generated; add no hand-written Zalo command router.

## Focused verification order

```bash
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-accounts-public-api.test.ts __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter chatbotx exec vitest run __tests__/openapi-loader-command-names.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter chatbotx-mcp exec vitest run
```

## Success criteria

- [x] API/private UI/CLI/MCP converge on the same services and policy errors.
- [x] Friend/group/label sync and direct/group send are agent-discoverable and scoped.
- [x] Public output contains no session/provider secrets.
- [ ] Generated command/tool names and documentation match the live spec.

## Rollback

Remove or hide new public routes only after disabling their UI callers; existing connection/group/label routes keep their compatible behavior.
