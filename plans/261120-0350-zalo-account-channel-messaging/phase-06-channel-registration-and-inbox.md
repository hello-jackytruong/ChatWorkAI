---
phase: 6
title: "Channel registration and Inbox lifecycle"
status: pending
priority: P1
effort: "L"
dependencies: ["Phase 5", "Approved foundation migration applied"]
---

# Phase 6: Channel registration and Inbox lifecycle

## Goal

Make `zaloAccount` a first-class, safely connectable ChatbotX channel without exposing encrypted credentials or changing existing channel behavior.

## Requirements

- Replace `CONNECTION_REGISTRY.zaloAccount = null` with a QR-device adapter using Phase 5 and the existing `ConnectSession` lifecycle.
- Add `zaloAccount` to `ChannelType`: creatable/manageable, no user credential form, no voice call, tenant-policy gated.
- Add a thin `integrations/zalo-account` package that never imports `zca-js`; context contains public account/inbox routing metadata only.
- Reuse the existing `Connection` and `IntegrationZaloAccount` binding; no second auth store.
- Build public API first for connect/session/status/reconnect/disconnect/account metadata; private/UI paths call the same services.
- Bind one Inbox/account row idempotently after verified identity; all client projections omit `encryptedAuth` and authorization backups.
- Reconnect preserves row/auth. Disconnect, tenant pause, trial teardown, deletion, and purge must confirm fence revocation before lifecycle/row mutation; the existing best-effort provider teardown rule is not sufficient for a local socket holding decrypted auth.
- Channel picker/settings/status/error/QR UI follows policy, i18n, and TanStack invalidation conventions.
- Audit every `Record<ChannelType, ...>` and choose explicit capabilities/defaults.

Public operations (using existing workspace-token scope conventions): `startZaloAccountConnect`, `getZaloAccountConnectSession`, `getZaloAccount`, `reconnectZaloAccount`, and `disconnectZaloAccount`. Private UI paths delegate to the same services; CLI/MCP/docs preserve the same stale/reauthorization/timeout errors.

## Key files

Create `integrations/zalo-account`, a builder `features/zalo-account` public/private API and UI module, and focused tests. Modify `packages/utils/src/channel.ts`, connection provider/QR adapter registries, SDK/integration registries, Zalo Account business services/projections, connection store binding, Inbox/purge orchestration, builder routing/i18n, and CLI/MCP/docs surfaces. Add/link the workspace only with package-manager commands.

## Tests before implementation (RED)

1. Connect returns `show_qr`; polling exposes allowed fields; completion creates exactly one Inbox/account row.
2. Cross-workspace/account/inbox access to status, QR, metadata, or disconnect fails.
3. Safe outputs never contain encrypted auth, cookie, IMEI, user-agent, or user secret columns.
4. Same verified UID completion is idempotent; different UID reconnect requires fresh QR. A `connect_session` QR runtime is stopped/revoked before an `account` runtime can acquire a new fence, so both refs never own sockets concurrently.
5. Runtime revoke/stop precedes disconnect/reconnect/delete/purge mutations.
6. Trial-expired workspaces may disconnect/delete but cannot create/reconnect.
7. Hidden policy blocks new creation while preserving management of an existing channel.
8. Existing OAuth/credential/Zalo OA/self-serve tests remain green.
9. Builder Edge graph cannot reach gateway/Node-only SDK code.

## Implementation steps (GREEN)

1. Apply the foundation migration only after explicit approval; otherwise keep DB integration tests opt-out.
2. Add ChannelType/capabilities and audit exhaustive plus partial maps: connection/integration/lookup registries, Inbox projections, label/audience/message capabilities, routes, and teardown/purge.
3. Build thin integration context from account ID, Inbox ID, verified UID, and public profile only.
4. Add a named provider-neutral trusted-device-completion path: only the trusted consumer may one-time claim the encrypted session/fence proof, skip the generic `provider.verify`, and invoke existing continuation/storage exactly once. Stop/revoke the `connect_session` runtime before the long-lived account runtime acquires its new fence.
5. Compose scoped public oRPC procedures with OpenAPI metadata; private actions delegate to identical service methods.
6. Implement idempotent binding, safe DTOs, and fail-closed reconnect/disconnect/tenant-pause/delete/purge order with a tombstone/epoch guard rejecting late commands or reacquisition.
7. Add UI/translations/query invalidation and propagate operations through CLI/MCP/docs.

## Refactor while green

Keep transport out of builder/integration context, share lifecycle services across public/private entry points, and prefer capabilities over channel-name conditionals.

## Tests after implementation

Run the Zalo integration, connection, and focused builder suites sequentially with one Vitest worker, then run final gates from `plan.md`.

## Todo

- [ ] Obtain migration approval before DB-backed operation/tests.
- [ ] Complete ChannelType/capability cascade.
- [ ] Add thin integration and safe routing context.
- [ ] Bind QR completion without duplicate login.
- [ ] Add public API and shared private/UI services.
- [ ] Add safe projections and teardown/purge order.
- [ ] Add UI/i18n/query invalidation and CLI/MCP/docs parity.
- [ ] Record sequential tests.

## Success criteria and rollback

Workspaces can connect/reconnect/disconnect a visible policy-gated Inbox; no credential reaches clients/caches/logs; current channels and Edge graph remain unaffected; purge leaves no socket using deleted auth. Roll back by disabling channel policy and stopping runtimes while retaining encrypted rows for controlled recovery.
