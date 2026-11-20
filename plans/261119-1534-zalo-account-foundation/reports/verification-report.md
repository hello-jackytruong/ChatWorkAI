# Verification report

Date: 2026-11-19
Tier: Standard (4 phases)
Roles: Fact Checker + Contract Verifier
Claims checked: 40
Verified: 40 | Failed: 0 | Unverified: 0

Proposed `Create` paths are not claimed to exist yet. The checks below verify
the current owners, symbols, consumers, and reference behavior that make each
planned change valid.

## Phase 1 — 10 claims

1. VERIFIED — `ConnectionStrategy` is the shared strategy union
   (`packages/sdk/src/lib/connection.ts:14-19`).
2. VERIFIED — the provider union has exactly OAuth, credential, and self-serve
   branches today (`packages/sdk/src/lib/connection.ts:85-131`).
3. VERIFIED — custom auth exists as a passthrough generic envelope, so a strict
   provider schema is still needed (`packages/sdk/src/lib/auth/index.ts:55-68`).
4. VERIFIED — `IntegrationType` is owned by
   `packages/database/src/partials/integration.ts:3-39`.
5. VERIFIED — current `IntegrationType` contains `zalo` but not `zaloAccount`
   (`packages/database/src/partials/integration.ts:37`).
6. VERIFIED — the connection registry is compile-time exhaustive
   (`packages/connections/src/registry.ts:142-149`).
7. VERIFIED — inert providers already use explicit `null` entries
   (`packages/connections/src/registry.ts:190,202`).
8. VERIFIED — the IntegrationType cascade currently has 11
   `Record<IntegrationType, ...>` consumers; exhaustive owners include registry
   and backfill fetchers, while other owners are explicitly `Partial`.
9. VERIFIED — existing Zalo OA owns a distinct `IntegrationZalo` schema
   (`packages/database/src/schema/integration-zalo.ts:18-59`).
10. VERIFIED — the reference project declares `zca-js` `^2.1.2`
    (`ZaloCRM/backend/package.json:67`), supporting the plan's exact compatibility pin.

Contract assessment: adding the enum literal will intentionally break exhaustive
maps at compile time. The phase requires an explicit inert/unsupported decision
at every exhaustive owner and leaves partial maps unchanged.

## Phase 2 — 10 claims

1. VERIFIED — `ConnectSessionNextAction` is already a discriminated union
   (`packages/utils/src/connection.ts:408-418`).
2. VERIFIED — current action variants are `open_url`, `enter_input`, and `wait`,
   so `show_qr` is additive (`packages/utils/src/connection.ts:409-415`).
3. VERIFIED — active and terminal session status partitions already exist
   (`packages/utils/src/connection.ts:431-459`).
4. VERIFIED — `ConnectSession` persists `nextAction`, encrypted auth, and expiry
   (`packages/database/src/schema/connect-session.ts:78-100`).
5. VERIFIED — session creation can build `nextAction` after minting a nonce
   (`packages/business/src/connect-session/service.ts:143-176`).
6. VERIFIED — `ConnectSessionService` has guarded authorization and action
   mutation methods (`packages/business/src/connect-session/service.ts:298,330,527`).
7. VERIFIED — `startConnect` is the shared app-layer implementation
   (`apps/builder/src/features/connections/lib/connect-flow.ts:72-90`).
8. VERIFIED — it currently handles self-serve, then credentials, then resolves
   OAuth credentials (`apps/builder/src/features/connections/lib/connect-flow.ts:110-149`).
9. VERIFIED — OAuth authorization and candidate continuation live in
   `packages/connections/src/connect-session-flow.ts:117,231,353` and are
   re-exported through `packages/connections/src/service.ts:40-45`.
10. VERIFIED — the builder public resource schema consumes the shared action
    schema (`apps/builder/src/features/connections/schema/resource.ts:7,98`).

Contract assessment: the new action has consumers in database typing, business
session service, connections orchestration, builder resource schema, API docs,
and tests. The phase names each owner and keeps gateway event ingress private.

## Phase 3 — 10 claims

1. VERIFIED — the existing Zalo OA satellite pattern has workspace and inbox
   cascade FKs (`packages/database/src/schema/integration-zalo.ts:22-36`).
2. VERIFIED — it indexes workspace and uniquely indexes inbox
   (`packages/database/src/schema/integration-zalo.ts:45-59`).
3. VERIFIED — its schema export is in
   `packages/database/src/schema/index.ts:141`.
4. VERIFIED — its relation module is imported by
   `packages/database/src/relations/index.ts:126`; the project invariant also
   requires spreading it into the relation object.
5. VERIFIED — the inbox reverse relation pattern exists
   (`packages/database/src/relations/inbox.ts:20-23`).
6. VERIFIED — current channel binding directly assumes an `auth` column and has
   no channel codec (`packages/business/src/connection/store-bindings.ts:161-294`).
7. VERIFIED — the workspace binding already provides the auth-column/codec
   precedent (`packages/business/src/connection/store-bindings.ts:297-355`).
8. VERIFIED — 12 existing channel bindings call `makeChannelBinding`
   (`packages/business/src/connection/store-bindings-channels.ts:128-432`), so
   default-compatible regression tests are mandatory.
9. VERIFIED — secret-safe public model precedent exists for User
   (`packages/database/src/types.ts:7-10`) and is enforced by
   `packages/database/__tests__/user-secret-projection.test.ts:55-81`.
10. VERIFIED — the database workspace owns `db:check-drift` and opt-in
    `test:db` scripts (`packages/database/package.json`).

Contract assessment: the encrypted channel codec is the only shared abstraction
added. Repository scope, schema/barrel/relations/types consumers, migration
artifacts, purge indexes, and secret projection are all named explicitly.

## Phase 4 — 10 claims

1. VERIFIED — the workspace glob already discovers every `apps/*` package
   (`pnpm-workspace.yaml:1-4`), so no glob change is required.
2. VERIFIED — realtime and javascript-executor provide existing standalone app
   script patterns (`apps/realtime/package.json:2-7`,
   `apps/javascript-executor/package.json:2-9`).
3. VERIFIED — Redis exposes `createRedisConnection`
   (`packages/redis/src/index.ts:51`, `src/redis-client.ts:4`).
4. VERIFIED — current distributed locking wraps an operation in
   `redLock.using` but exposes no fencing token
   (`packages/redis/src/distributed-lock.ts:55-85`).
5. VERIFIED — CAS primitives exist for conditional set/swap/delete
   (`packages/redis/src/cas-store.ts:101,148,170`) but do not atomically issue a fence.
6. VERIFIED — realtime already implements readiness state and health/ready
   endpoints (`apps/realtime/src/gateway.ts:109,310-318`).
7. VERIFIED — realtime installs SIGINT/SIGTERM shutdown handlers
   (`apps/realtime/src/main.ts:14-17`) and guards shutdown idempotently
   (`apps/realtime/src/shutdown.ts:6-29`).
8. VERIFIED — no `zca-js` or `zalo-account-gateway` import exists in ChatbotX
   outside this plan at verification time.
9. VERIFIED — reference QR lifecycle uses teardown, local epoch, bounded QR
   retry, `selfListen`, and stale callback guards
   (`ZaloCRM/backend/src/modules/zalo/zalo-pool.ts:137-250`).
10. VERIFIED — reference reconnect/listener behavior suppresses concurrent
    reconnect, verifies UID, ignores stale close events, and trips a
    five-in-five-minute breaker (`zalo-pool.ts:358-401,475-538`); its listener
    uses `retryOnClose` (`zalo-listener-factory.ts:996`).

Contract assessment: app discovery, Redis client, health/readiness, shutdown,
and reference lifecycle consumers are accounted for. The plan deliberately
adds no transport endpoint and keeps the SDK outside builder/import graphs.

## Whole-plan consistency sweep

- Files reread: `plan.md`, four phase files, `scout-report.md`.
- Decision deltas checked: cookie shape, secret projection naming,
  IntegrationType cascade, exact dependency install, DB-test command, and
  CLI/MCP/docs propagation.
- Reconciled stale references: 5.
- Unresolved contradictions: 0.
