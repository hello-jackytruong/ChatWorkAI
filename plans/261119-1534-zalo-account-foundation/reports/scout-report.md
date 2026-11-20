# Scout report — Zalo Account foundation

Date: 2026-11-19

## Current ChatbotX seams

- `packages/sdk/src/lib/connection.ts:8-19` explicitly anticipates an additive
  QR/device strategy, while the provider union at `:85-131` has no such branch.
- `packages/utils/src/connection.ts:408-415` has a discriminated `nextAction`
  union with `open_url`, `enter_input`, and `wait`; QR fits this server-driven seam.
- `packages/business/src/connect-session/service.ts:115-129` describes
  `ConnectSession` as registry-free, DB-backed, server-driven multi-step state.
- `packages/database/src/schema/connect-session.ts:43-100` already persists
  workspace/provider/status/step/nextAction/encryptedAuth/expiry. A new QR
  session table would duplicate this model.
- `apps/builder/src/features/connections/lib/connect-flow.ts:79-149` is the
  shared public/private start implementation and currently falls through to
  OAuth after self-serve and credential branches.
- `packages/business/src/connection/store-bindings.ts` supports encrypted codecs
  for workspace integrations but the channel factory assumes a plain `auth`
  column, so Zalo Account needs a small compatible extension.
- `packages/redis/src/distributed-lock.ts:38-72` offers operation-scoped
  `runExclusive` but does not expose a fencing token. `cas-store.ts:95-181`
  offers CAS primitives but not atomic fence issuance.

## Reference project lessons

Source: `/Users/jacky/Documents/Github/ZaloCRM/backend/src/modules/zalo/`.

- `zalo-pool.ts:137-158`: stop the old listener before replacement; otherwise
  duplicate WebSockets flap each other.
- `zalo-pool.ts:187-250`: local epoch guards are required for QR callbacks and
  login promises that resolve after a new session replaces them.
- `zalo-pool.ts:194-224`: QR regeneration must be bounded and eventually require
  a fresh user-initiated session.
- `zalo-pool.ts:233-238`: the SDK emits cookie/IMEI/user-agent only after login info.
- `zalo-pool.ts:258-259`: verified identity comes from `getOwnId()`.
- `zalo-pool.ts:358-401`: duplicate reconnects are suppressed and reconnect
  must reject a different UID.
- `zalo-pool.ts:475-538`: stale close events are ignored and repeated disconnects
  trip a circuit breaker instead of reconnecting forever.
- `zalo-listener-factory.ts:996`: listener uses retry-on-close; ChatbotX must
  still own the outer lifecycle and lease to prevent cross-replica duplication.

## Design conclusion

Reuse ChatbotX's connection/session/security primitives, but keep the unofficial
SDK and long-lived sockets in a separate app. Use both local epoch and
distributed fencing: epoch protects replacement inside one process; fencing
protects ownership across replicas. Defer transport, channel registration, and
message/group/tag behavior until their checklist items so this foundation stays
small and testable.
