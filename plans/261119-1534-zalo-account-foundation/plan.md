---
title: "Zalo Account foundation"
description: "TDD plan for the connection contract, QR-device engine, encrypted data model, and isolated WebSocket gateway."
status: completed
priority: P1
effort: "L"
tags: [zalo-account, connection-engine, gateway, tdd]
created: 2026-11-19
---

# Zalo Account foundation (items 1–4)

## Overview

Add the minimum foundation required for a future personal Zalo channel without
disturbing the running OAuth/credential channels. The design adds one generic
connection strategy (`qr_device`) and one provider-specific runtime app
(`zalo-account-gateway`). It reuses `ConnectSession`, encrypted authorization,
`Connection`, Redis, and existing business/repository boundaries.

This plan intentionally stops before channel registration, command/event
transport, Inbox UI, messages, groups, tags, broadcasts, and flow steps. Those
are later checklist items and must consume the contracts established here.

Evidence used to build the plan is recorded in
[reports/scout-report.md](./reports/scout-report.md).

## Accepted contract

| Item | Decision |
|---|---|
| Provider identifier | Reserve `zaloAccount`; do not reuse `zalo` (Zalo OA). |
| Connection strategy | Additive `qr_device`; no parallel login state machine. |
| User-entered credentials | None. QR scan supplies the authorization. |
| Stored secret | `authType: "custom"`, `cookie`, `imei`, `userAgent`; persist only after schema validation and encryption. |
| Verified identity | `zaloUid` returned by `getOwnId`; reconnect must reject a different UID. |
| QR presentation | `ConnectSession.nextAction = { type: "show_qr", imageDataUrl, expiresAt }`; clear it after scan/terminal transition. |
| Durable ownership | `Connection` remains the lifecycle source of truth; `IntegrationZaloAccount` stores provider identity/profile and encrypted auth only. |
| Runtime ownership | At most one live SDK listener per account across all gateway replicas, enforced by a renewable Redis lease with fencing token. |
| Platform credentials | None. |
| SDK dependency | Pin the same `zca-js` release proven by the reference project (`2.1.2`); upgrade only through a separate compatibility change. |

## Scope

### In scope

- Freeze provider/auth/session/runtime contracts and document unsupported-provider risk.
- Extend the shared connection engine for a generic asynchronous QR/device flow.
- Add encrypted Zalo Account satellite storage and its business/repository boundary.
- Add an independently deployable gateway with QR login, credential reconnect,
  listener lifecycle, lease/fencing, retry policy, health/readiness, and graceful shutdown.
- Add tests first in every phase; preserve all existing connection strategies.

### Explicitly out of scope

- Adding `zaloAccount` to `ChannelType`, the channel picker, tenant visibility,
  Inbox creation, or `CONNECTION_REGISTRY` as a usable channel.
- BullMQ/Redis command and event transport between builder/worker and gateway.
- Message normalization, send/receive, group Inbox/policy, tags/labels, contacts,
  broadcasts, flow steps, webhooks, or history sync.
- A generic “gateway plugin framework”; only the seam needed by this gateway is defined.
- Applying database migrations. Migration SQL is generated and reviewed only;
  execution requires separate explicit approval.

## Architecture boundary

```text
Public/private connection API
        │
        ▼
shared startConnect → ConnectSession (`qr_device`, `show_qr`)
        │                         ▲
        │ future command/event    │ (item 5; not in this plan)
        ▼                         │
zalo-account-gateway ── zca-js WebSocket
        │
        ├─ Redis lease + fencing (ephemeral ownership)
        └─ business service → repository → encrypted DB row (durable secret)
```

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Establish stable, explicit contracts for Zalo personal-account authorization and runtime events. | P1 |
| 2 | Add QR-device support without regressing OAuth, credential, or self-serve connections. | P1 |
| 3 | Ensure raw Zalo session credentials never persist or appear in logs unencrypted. | P1 |
| 4 | Run WebSocket sessions in a horizontally scalable, isolated gateway with single-owner semantics. | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Contract and boundaries](./phase-01-contract-and-boundaries.md) | Complete |
| 2 | [QR-device connection engine](./phase-02-qr-device-connection-engine.md) | Complete |
| 3 | [Secret and data model](./phase-03-secret-and-data-model.md) | Complete |
| 4 | [WebSocket gateway runtime](./phase-04-websocket-gateway-runtime.md) | Complete |

## Dependencies and sequencing

- Phase 1 is the contract gate for all later phases.
- Phase 2 depends on Phase 1 schemas and may use a fake QR provider in tests; it
  must not import `zca-js`.
- Phase 3 depends on the Phase 1 auth contract and runs after Phase 2 on this
  host so implementation and every verification command remain single-threaded.
- Phase 4 depends on Phases 1 and 3. Its in-process ports are ready for item 5,
  but item 5 is not implemented here.

## Cross-phase TDD gate

For every behavior slice: add or tighten a test, run it and record the expected
failure, implement the smallest behavior that makes it pass, refactor only while
green, then run the affected workspace suite. Do not write a broad mock-only
test where an existing repository/service integration test can prove the contract.

Run install, test, typecheck, build, and lint commands strictly one at a time
with single-worker test settings; do not parallelize verification on this host.

Focused command pattern:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter <workspace> exec vitest run <test-file>
```

Final gates, in order:

```bash
pnpm turbo run lint --concurrency=1
pnpm turbo run check-types --concurrency=1
VITEST_MAX_WORKERS=1 pnpm turbo run test --concurrency=1
```

## Success Criteria

- [x] `qr_device` and `show_qr` are additive, schema-validated contracts and all existing connection-engine tests remain green.
- [x] A fake QR provider proves start → QR → scan → verified auth → completion/reconnect behavior without OAuth credentials.
- [x] Zalo Account auth fails closed on malformed cookie/IMEI/user-agent/UID and is encrypted at rest with workspace/inbox-bound AAD.
- [x] A Zalo Account row is unique per `(workspaceId, zaloUid)`, scoped by workspace on every read/write, and removed by existing FK cascades.
- [x] Two gateway replicas racing for one account result in one active listener; a stale owner cannot renew, release, publish, or reconnect after losing its fence.
- [x] QR retry is bounded, stale SDK callbacks are ignored, manual stop is not auto-reconnected, and reconnect identity mismatch requires a fresh QR session.
- [x] Gateway readiness turns false when Redis or required runtime dependencies are unavailable; shutdown stops listeners and releases owned leases.
- [x] No `zca-js` import is reachable from builder/router/Edge graphs.
- [x] No raw cookie, QR image, IMEI, or user-agent value is emitted to structured logs or public error messages.
- [x] Migration SQL is generated, inspected, and left unapplied pending explicit approval.
- [x] Public API contract changes are propagated through the repository's
  `cli-mcp-docs` workflow so agents see the same QR action contract as the UI/API.

## Rollout and rollback

1. Merge contracts and engine support with no registered Zalo Account channel;
   this is inert for current providers.
2. Merge schema/migration artifacts but do not apply the migration in this task.
3. Deploy the gateway disabled by default (`ZALO_ACCOUNT_GATEWAY_ENABLED=false`)
   and verify health/readiness plus lease tests in staging.
4. Item 5+ may wire transport and registration behind a provider feature flag.

Rollback is code-only for Phases 1, 2, and 4 while the provider remains
unregistered. For Phase 3, rollback the application before considering schema
removal; do not drop a table containing encrypted sessions without a separate,
explicit data-retention decision.

## Risks and controls

| Risk | Control |
|---|---|
| Unofficial personal-account API changes or account restrictions | Isolate `zca-js`, pin version, surface reauthorization, document operator/legal risk; do not reuse the Zalo OA module. |
| Duplicate sockets across replicas | Redis lease + fencing token, local epoch guard, teardown-before-replace, stale-callback tests. |
| Secret leakage | Provider schema, encrypted column, AAD binding, redacted logs, public projection tests. |
| QR replay/stale update | Workspace-scoped session lookup, expiry, fresh session after retry exhaustion, terminal action clearing. |
| Shared engine regression | Additive union branches and full existing connection test suite. |
| Premature complexity | No message bus, generic gateway framework, group model, sync cursor, or UI in this plan. |

## Validation Log

### 2026-11-20 — Implementation verification

- Completed all four phases: `ak plan status` reports 4/4 phases and 41/41
  tasks complete.
- Ran all install, build, lint, typecheck, and test commands sequentially with
  single-worker/concurrency settings to keep memory usage bounded.
- `pnpm turbo run lint --concurrency=1` passed, including database schema drift
  and Ultracite checks.
- `pnpm turbo run check-types --concurrency=1` passed for all 69 tasks.
- `VITEST_MAX_WORKERS=1 pnpm turbo run test --concurrency=1` passed all 70
  workspace tasks; builder passed 1,213 files / 11,139 tests and worker passed
  400 files / 5,436 tests.
- Gateway-focused tests and build passed; independent code review found no
  remaining blocker within items 1–4.
- Generated migration `20261119161633_zalo-account` was inspected and remains
  unapplied. Database integration against that table is deferred until explicit
  migration approval, as required by repository policy.

### 2026-11-19 — Standard verification

- Tier result: 40 claims checked; 40 verified, 0 failed, 0 unverified. Full
  evidence and consumer assessment are in
  [reports/verification-report.md](./reports/verification-report.md).
- Fact checked the connection strategy and provider union in
  `packages/sdk/src/lib/connection.ts`, the `nextAction` and status schemas in
  `packages/utils/src/connection.ts`, the shared app entry point in
  `apps/builder/src/features/connections/lib/connect-flow.ts`, and the durable
  session columns in `packages/database/src/schema/connect-session.ts`.
- Verified the existing `ConnectSessionService` is intentionally
  registry-free and already supports server-driven `nextAction` updates.
- Verified the current distributed lock does not expose a fencing token, while
  `casStore` supplies JSON CAS primitives; therefore a small gateway-owned Lua
  lease is planned instead of holding `runExclusive` for a socket lifetime.
- Verified the reference project requires teardown-before-replace, epoch
  guards, bounded QR retry, reconnect identity verification, and a disconnect
  circuit breaker.
- Contract check: every new app/database write routes through a business
  service/repository boundary; no builder/worker direct DB access is planned.

### Whole-plan consistency sweep

- Files reread: `plan.md`, all four phase files, and both reports.
- Decision deltas checked: 6.
- Reconciled stale references: 5.
- Unresolved contradictions: 0.

## Red Team Review

### Session — 2026-11-19

**Findings:** 8 (7 accepted, 1 rejected)
**Severity breakdown:** 1 Critical, 4 High, 3 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| 1 | Long-lived `runExclusive` has no usable fence for stale socket callbacks | Critical | Accept | Phase 4 gateway-owned fenced lease |
| 2 | QR images can remain in `nextAction` after scan/termination | High | Accept | Phase 2 action clearing and expiry tests |
| 3 | Reconnect credentials could authenticate a different Zalo UID | High | Accept | Phases 1 and 4 identity-match invariant |
| 4 | Adding `IntegrationType` makes the registry exhaustive | High | Accept | Phase 1 adds explicit inert `null`; usable registration remains out of scope |
| 5 | A generic channel binding currently assumes a plain `auth` column | High | Accept | Phase 3 adds an encrypted channel auth codec with regression tests |
| 6 | A new workspace table could make purge unbounded | Medium | Accept | Phase 3 indexed FKs, cascade, purge tests |
| 7 | Building command/event transport now would duplicate checklist item 5 | Medium | Accept | Phase 4 exposes ports only |
| 8 | Add group/thread policy tables now for future group support | Medium | Reject | No current owner/semantics; outside items 1–4 and would be speculative schema |

The accepted findings are incorporated into the phase files. Finding 8 is
rejected because group control is a later checklist item and no current
message/thread contract exists to validate such a table.

<!-- slug: zalo-account-foundation -->
