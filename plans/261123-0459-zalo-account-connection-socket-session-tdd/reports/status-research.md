# P0.1 status/socket/session research

Research date: 2026-11-23 (Asia/Ho_Chi_Minh). Scope is planning evidence only: safe
connection/socket/session status, QR outcomes, realtime invalidation, and the
smallest compatible UI change. No source files were changed.

## Recommendation

Use the existing `IntegrationZaloAccount.operations.runtime` JSON as the durable
latest runtime snapshot, written only inside the existing fence transaction. Keep
`Connection.status/statusReason` as lifecycle truth and the Redis lease as the
gateway-liveness probe. Add a small lease-fenced Redis `lastEvent` mirror only for
fresh ephemeral diagnostics (TTL at least 2 x the 30-second lease TTL); it must
never outrank the durable row and must not create per-message DB writes. Do not
add an event-log table in P0.1.

Expose an additive, safe runtime projection from the existing status service:

```ts
status: "connected" | "degraded" | "needs_reauth" | "paused" | "disconnected"
reason: AllowlistedConnectionStatusReason | null
gatewayAvailable: boolean
runtime?: { state: "connected" | "closed" | "reauthorization_required"; occurredAt: string }
```

The SDK already orders `{ fenceToken, epoch, occurredAt, state }` with fence token
first (`packages/sdk/src/lib/zalo-account.ts:161-187`), and
`withRuntimeFence` row-locks, rejects older events, and writes `operations.runtime`
in one transaction (`packages/database/src/repositories/integration-zalo-account/repository.ts:31-73`).
That comparator does not provide a monotonic socket-attempt sequence when events
share a runtime fence/epoch and timestamp; do not claim it totally orders every
same-runtime attempt. If the Redis `lastEvent` mirror is added, include an
internal stream/event sequence (or Redis stream ID) and enforce lease ownership in
the write script; expose neither sequence nor lease value.
The projection must omit fence token, epoch, lease owner/value, QR bytes, auth,
provider error text, cookies, IMEI, and user-agent. `Connection.statusReason` is
already a bounded enum (`packages/database/src/schema/connection.ts:38-76`,
`packages/utils/src/connection.ts:35-50`); translate it through the existing
status-message map (`apps/builder/src/features/connections/lib/status-message.ts:13-25`).

## Current contract and gaps

| Evidence | Current behavior | Planning consequence |
| --- | --- | --- |
| `packages/business/src/zalo-account/service.ts:31-98` | Status reads Connection plus group/friend/label JSON and checks whether the account lease value matches `/:\\d+$/`. It has no runtime state/last event/freshness field. | Add only an additive runtime projection; do not make UI infer liveness from Connection alone. |
| `packages/database/src/schema/integration-zalo-account.ts:44-97` | Existing JSON already stores groups, labels, friends, and optional runtime order; there is no status event log. | JSONB is migration-free and durable across gateway restarts; a lease-fenced Redis `lastEvent` can add bounded freshness without per-message DB writes. |
| `packages/business/src/zalo-account/runtime-state.service.ts:11-67` | `connected`, `closed`, and `reauthorization_required` map to the Connection FSM; the apply path accepts only active `connected/degraded` rows. | A runtime callback must not revive `needs_reauth/paused/disconnected`; reconnect uses `connect.completed` separately. |
| `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:26-86,265-286` | Gateway states include `idle`, `qr_pending`, `reconnecting`, `connected`, `backoff`, `reauth_required`, `stopped`; lease renewal is 10s against a 30s TTL. | `gatewayAvailable` is a liveness fact, not a durable state. Missing lease means interrupted/unavailable even if Connection says connected. |
| `apps/worker/src/events/zalo-account/handler.ts:38-82,84-271` | Account lifecycle events reach runtime-state service. Connect-session handling only acts on `qr_scanned`, encrypted QR, and authorization; it ignores lifecycle reauth/closed events. | QR rejection/expiry can leave a session pending until lazy/cron expiry unless worker maps reauth to a terminal safe error. |
| `apps/builder/src/features/zalo-accounts/components/zalo-account-status.tsx:6-38` | UI maps connected+lease to active, connected/degraded without lease to degraded, needs_reauth to reconnect-required, paused/disconnected to their labels. | “Interrupted” can remain a derived safe label (`connected|degraded && !gatewayAvailable`); no new Connection enum is necessary. |

## Minimal action/hook change (preserve consumers)

`getZaloAccountOperationsAction` is `superAdmin`-gated and always performs a
status read plus a group list (`apps/builder/src/features/zalo-accounts/actions/account-operations.action.ts:17-28`).
`useZaloAccountOperations` polls that full `{ status, groups }` result every 30s
(`apps/builder/src/features/zalo-accounts/queries/use-account-operations.ts:6-28`).
The manage row and the groups panel both consume it
(`apps/builder/src/features/zalo-accounts/components/zalo-account-manage.tsx:32-73,172`,
`apps/builder/src/features/zalo-accounts/components/zalo-account-groups.tsx:190-220`).

Ranked choice:

1. Add `getZaloAccountStatusAction` and `useZaloAccountStatus` with a separate
   `zalo-account-status` query key; switch only the account-list/manage status
   display to it. Leave `getZaloAccountOperationsAction` and
   `useZaloAccountOperations` unchanged for the groups panel and existing tests.
   This removes per-row group-list polling without changing the full operations
   contract.
2. Make the existing hook option-dependent (`includeGroups`) and change its
   return shape. Lower compatibility: current groups tests/mocks and any future
   callers can accidentally receive a status-only object.
3. Replace the action contract. Reject: it breaks the groups consumer and the
   API-parity/UI fixtures for no material benefit.

Mutation invalidation must cover both keys; a status event invalidates the
status-only key and the full operations key only when the detail/groups panel is
mounted. Cancel the status query before optimistic disconnect updates and never
apply event payload as truth. A QR dialog must still close only after the
ConnectSession reaches `completed`; an account status event arriving before the
session/account transaction commits is only an invalidation hint.

## Realtime contract and privacy

Add one workspace-only event, for example `zaloAccountStatusChanged`, whose data
is exactly `{ accountId }`. It is an invalidation ID, not a status payload. Do
not include reason, raw close/error text, `fenceToken`, epoch, lease owner, QR,
profile, or auth. The envelope already carries workspace scope.

Publish after `withRuntimeFence` returns accepted/committed; do not publish on a
stale event or before the DB transaction. Use the existing coalescing publisher
(`packages/business/src/platform/realtime-broadcast.ts:224-332`) and invalidate
only matching account query keys in the builder. The event must not be added to
`guestRealtimeEventTypes`; guest data is separately constrained in
`packages/realtime-protocol/src/schemas.ts:30-64,656-660`. Existing builder
workspace clients ignore unknown event names (`apps/builder/src/features/realtime/workspace-realtime-provider.tsx:151-156`),
so old clients remain safe during mixed deploys; new clients refetch through the
authorized action rather than trusting the ID event.

Do not reuse the ZaloCRM raw Socket.IO pattern. It is useful only as a lesson:
the listener scopes events to an organization room (`ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:393-410`),
filters the active account before closing a QR dialog, and re-subscribes after a
transport reconnect (`ZaloCRM/frontend/src/composables/use-zalo-accounts.ts:185-217`).
It also emits raw provider `code/reason` at lines 609-614 and 986-990; that is
not appropriate for this workspace-member, IDs-only contract. Its dashboard
also falls back from pool live status to DB status (`ZaloCRM/backend/src/modules/zalo/zalo-dashboard-routes.ts:158-176,242-265`),
which confirms the useful two-source model but not its implementation details.

## Auth update fence

The generic reconnect path already writes the satellite auth and Connection FSM
inside one transaction (`packages/connections/src/connect-session-flow.ts:646-707`),
then activates after commit (`:709-723`). The generic Zalo binding encrypts auth
and sets UID/session verification (`packages/business/src/connection/store-bindings-channels.ts:441-455`;
`packages/business/src/connection/store-bindings.ts:259-280`). Preserve this path.

The separate `zaloAccountService.saveAuthorization` is a plain read, identity
check, encrypt, and update (`packages/business/src/zalo-account/service.ts:177-214`;
`packages/database/src/repositories/integration-zalo-account/repository.ts:328-349`)
and has no runtime fence/row lock. It has no production caller beyond its unit
fixture (`rg` found only the service and `packages/business/__tests__/zalo-account.service.test.ts:235-266`).
Either route future use through the generic reconnect transaction or add a
repository method that locks the account row, rechecks workspace/inbox/UID, and
updates auth/profile only with the expected runtime generation. A stale QR/auth
callback must not overwrite newer encrypted auth or profile data. Add a race test
before changing this helper; do not add a second event table.

## QR/session facts and TDD targets

The pinned SDK is `zca-js: 2.1.2` (`apps/zalo-account-gateway/package.json`). Its
actual callback enum includes `QRCodeGenerated`, `QRCodeExpired`,
`QRCodeScanned`, `QRCodeDeclined`, and `GotLoginInfo`
(`node_modules/.pnpm/zca-js@2.1.2/node_modules/zca-js/dist/apis/loginQR.d.ts:3-8`).
Generated/scanned/expired/declined callbacks all provide `actions.abort`; the
expired/scanned/declined callbacks also provide retry (`loginQR.d.ts:21-50`).
The current adapter maps generated/expired/scanned/credentials but drops
`QRCodeDeclined` (`apps/zalo-account-gateway/src/runtime/zca-client.ts:299-331`).
P0.1 must add a bounded `declined` adapter event, preserve the abort control,
call abort once, and map it to `reauthorization_required: authorization_rejected`
without automatic retry. The runtime retries QR expiry twice, then emits
`reauthorization_required: qr_expired` (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:334-379`);
identity mismatch and connect failures already map to bounded lifecycle reasons
(`:381-407`).

P0.1 tests should prove:

- SDK lifecycle/secret unions continue to keep QR bytes and auth out of ordinary
  lifecycle data (`packages/sdk/__tests__/zalo-account-transport.test.ts`), and
  runtime ordering rejects lower fence/epoch/time (`packages/sdk/__tests__/zalo-account-runtime-order.test.ts`).
- Gateway adapter/runtime tests cover `QRCodeDeclined`: the adapter preserves the
  SDK abort callback, the runtime invokes it once, emits only the bounded
  `authorization_rejected` lifecycle outcome, and never retries a user-declined
  QR (`apps/zalo-account-gateway/__tests__/zalo-account-runtime.test.ts`).
- `withRuntimeFence` writes only newer snapshots; stale closed/reauth events do
  not overwrite a later connected snapshot, and accepted events produce one
  workspace ID-only invalidation.
- Status never serializes encrypted auth, cookies, IMEI, user-agent, lease value,
  raw reason, or fence token (`packages/business/__tests__/zalo-account.service.test.ts:107-190`).
- Connect-session handler maps `qr_expired` to `expired`, identity mismatch to a
  safe provider-denied outcome, authorization rejection to provider error, and
  ignores stale/duplicate terminal transitions; QR secret remains decrypted only
  in worker (`apps/worker/__tests__/zalo-account-events.test.ts`).
- Status-only manage polling never calls group list; groups panel retains its
  full `{status,groups}` contract. Realtime invalidation is account-scoped,
  guest-excluded, and cannot close an unrelated QR dialog. Extend
  `apps/builder/__tests__/zalo-account-manage-ui.test.tsx`,
  `zalo-account-connect-ui.test.tsx`, and `zalo-accounts-ui.test.tsx`.

## Callers and focused commands

Key callers: public status route `apps/builder/src/features/zalo-accounts/api/operations.ts:152-169,193-200`;
status action/hook/manage/groups above; gateway lifecycle → worker handler →
runtime-state service → fenced repository. Existing focused commands:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-transport.test.ts __tests__/zalo-account-runtime-order.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account.service.test.ts __tests__/zalo-account-runtime-state.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/device-session-flow.test.ts __tests__/integration/connect-session-flow.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-account-manage-ui.test.tsx __tests__/zalo-account-connect-ui.test.tsx __tests__/zalo-accounts-ui.test.tsx
pnpm check-types:cold
```

Limitations: this is local repository/reference research only; no remote API or
live gateway was exercised. It does not prove production Redis latency, gateway
restart behavior, or an exact frontend realtime mount for the new event; those
belong in implementation-phase integration tests.

Status: DONE_WITH_CONCERNS
Summary: Durable, fence-ordered `operations.runtime` plus a lease-fenced Redis
`lastEvent` mirror, Connection/lease projection, and no per-message DB writes is
the smallest migration-free status design. Add a status-only superAdmin
action/hook for manage rows, preserve the full operations contract for groups,
emit workspace IDs-only invalidations, map SDK QR decline/abort, and terminalize
QR reauth events in the worker.
Concerns/Blockers: The standalone `saveAuthorization` helper lacks a production
caller and a transaction fence; implementation should either retire its use or
add a row-lock/expected-generation test before exposing it to reconnect flows.
