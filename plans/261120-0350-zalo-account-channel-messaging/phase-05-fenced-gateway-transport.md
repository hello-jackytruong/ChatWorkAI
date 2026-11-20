---
phase: 5
title: "Fenced gateway transport"
status: pending
priority: P1
effort: "L"
dependencies: ["Zalo Account foundation phases 1-4"]
---

# Phase 5: Fenced gateway transport

## Goal

Replace the gateway's no-op sink/in-process-only ports with durable typed command and event transport while preserving single-owner execution and secret isolation.

## Contract

- Define versioned command/event schemas in a Node-safe shared subpath; no `zca-js`, database client, or builder router imports.
- Command envelope: `commandId`, `kind`, `workspaceId`, `inboxId`, `accountId`, `createdAt`, `expiresAt`, and optional target `{runtime, epoch, fenceToken}`.
- Event envelope: `eventId`, `kind`, same scope/route identifiers, `{runtime, epoch, fenceToken}`, provider event/message ID when present, and a typed non-secret payload.
- Untargeted start commands enter one durable acquisition stream/consumer group; one replica claims the job and races for the lease. Commands for a live runtime go to a bounded owner-mailbox stream resolved from the current lease. A normal shared consumer group is never treated as broadcast.
- Owner mailbox keys have TTL/MAXLEN and a stable production `ownerId`; cursor/result state has bounded TTL and cleanup. Wrong-owner or stale-target commands are rejected before SDK invocation.
- Operational/send commands target the exact workspace/account/Inbox/fence tuple. Stop/disconnect atomically revokes that same fence before returning; the old owner stops when renew/assert fails.
- Results correlate by `commandId`, have bounded TTL, and distinguish success, stale rejection, timeout, provider failure, and ambiguous outcome.
- Event publication atomically compares the current lease owner/fence and appends to the event stream. A stale callback can never append.
- QR and auth completion use a dedicated encrypted, session-bound envelope. AAD covers workspace/session/account/command/runtime/fence; it is one-time claimed, TTL-bound, redacted from DLQ/telemetry, and decryptable only by the trusted completion consumer. The authorized ConnectSession projection may return the short-lived QR image and must clear it on scan/expiry/cancel/terminal state.
- Consumer groups provide retry/reclaim; stable IDs prevent repeated session transitions and integration jobs.
- Before any non-idempotent SDK call, claim a scoped Redis idempotency record `(workspace, account, kind, commandId)` as `pending`; after the call record `applied` or `unknown`. Reclaim of `pending/unknown` never calls the SDK again.
- Every accepted provider job carries top-level trusted `workspaceId`, `inboxId`, and account-row ID; `zaloUid` is identity data only and never a generic unscoped route key.
- Startup reconciles bounded pages of durably active accounts before readiness, while a durable manual-disconnect/tombstone state prevents resurrection. Two replicas still converge on one fence.
- Stream and payload limits cover bytes, items, age, and worst-case outage lag. Parse/schema poison goes to a bounded redacted DLQ and is acknowledged; pending entries are never silently trimmed.
- Readiness requires Redis plus live command/event consumers and lag/heartbeat thresholds. Shutdown has a deadline: reject work, pause consumers, revoke fences, stop listeners, bounded drain, close Redis.
- Provider outcomes distinguish reauthorization, denied, rate-limited, transient, and ambiguous. Per-account plus provider-wide admission/circuit budgets pause reconnect/group/label work during outages.

## Key files

Create shared transport schemas under `packages/sdk`, stream configuration under `packages/worker-config`, gateway Redis command/event adapters under `apps/zalo-account-gateway/src/transport`, and a worker consumer under `apps/worker/src/zalo-account/events`. Modify gateway `main.ts`, runtime ports, lease store, pool, package exports, and the worker event registry. Add focused tests in gateway and worker `__tests__` directories. Exact filenames may follow the nearest package convention; the ownership boundaries above must not change.

## Tests before implementation (RED)

1. Reject missing scope, expired commands, unknown versions/kinds, malformed fence targets, and secret fields on ordinary events.
2. Two acquisition consumers race across start jobs and exactly one current fence owns/starts the listener; owner-mailbox commands reach only that owner.
3. A command for another fence is rejected without invoking the SDK port.
4. A stale callback fails atomic fence-and-append even if its local epoch looks current.
5. Consumer restart/reclaim applies an unacknowledged event once at the business boundary.
6. Repeated event/provider IDs do not enqueue duplicate jobs or repeat a session transition.
7. Auth ciphertext is readable only by the trusted consumer and never appears in logs/results.
8. Crash after provider call but before acknowledgement leaves the command `unknown` and reclaim does not resubmit it.
9. Restart restores eligible sockets but never a manual disconnect; two replicas still yield one owner.
10. Poison/oversized entries, retention pressure, hanging shutdown, Redis outage, and rate-limit bursts remain bounded and observable.

## Implementation steps (GREEN)

1. Add minimal v1 shared schemas and exhaustive unions.
2. Add dedicated Redis streams/keys, bounded retention, consumer names, and result TTL; never reuse realtime streams.
3. Extend the lease store with Lua-backed atomic fence assertion plus `XADD`, and tested revoke behavior.
4. Implement acquisition-stream claiming plus bounded owner-mailbox routing through the existing per-account serialized pool; add mailbox/cursor cleanup.
5. Replace the no-op sink with the fenced publisher; retain local epoch checks.
6. Let the worker consumer call connection services for trusted lifecycle events and enqueue scoped integration jobs for message/echo or dedicated group-resource events.
7. Add bounded reclaim, redacted structured errors, lag/reject/timeout metrics, and graceful shutdown ordering.
8. Add desired-state reconciliation, provider-wide backoff, poison handling, retention-gap alarms/backpressure, hard payload limits, readiness heartbeat, and timed shutdown.

## Refactor while green

Keep Redis mechanics in transport modules, runtime ownership in pool/lease store, and provider-neutral errors outside the gateway. Extract only helpers used by two paths; do not build a generic gateway bus.

## Tests after implementation

Run focused gateway, worker, event-bus, then full gateway suites sequentially with `VITEST_MAX_WORKERS=1`. Run the repository final gates from `plan.md` afterward, one at a time.

## Todo

- [ ] Freeze schemas and route identifiers.
- [ ] Prove broadcast start and targeted ownership.
- [ ] Implement atomic fence validation plus append.
- [ ] Encrypt/isolate auth completion.
- [ ] Add durable consumption, reclaim, dedupe, result TTL, and shutdown.
- [ ] Add startup reconciliation, bounded poison/retention handling, readiness, and provider-wide backoff.
- [ ] Bridge accepted events to existing services/jobs.
- [ ] Record sequential test evidence.

## Success criteria and stop signals

Only the current fenced owner executes/publishes; restarts do not duplicate durable effects; no secret leaks; gateway never writes application tables or client realtime. Stop if configured Redis cannot atomically fence-and-append, mailbox routing cannot be bounded, or a new command requires application DB access beyond the existing secret-load service seam. Roll back to disabled transport while the visible channel stays gated.
