# Failure-mode and contract review — P0.1

Scope: plan only, with read-only inspection of the four plan files and the
current gateway/runtime, SDK, Redis, worker, and connection-session seams named
by those plans. No tests, typechecks, lint, builds, migrations, provider calls,
or source edits were run. Findings are limited to the three lifecycle/recovery
risks most likely to break production ownership.

## Findings

### High — cancellation has no awaited resource boundary, so old login/socket work can outlive the lease

Plan locations: `phase-01-start.md:39-45,147-149`; `phase-02-socket-runtime-and-session.md:28-46,65-71,132-152,198-203,227-232`.

Evidence:

- The internal port currently exposes `loginQr`/`login` as bare promises and a
  synchronous `listener.stop()` (`apps/zalo-account-gateway/src/runtime/ports.ts:93-133`).
  The runtime starts QR login detached (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:88-111`),
  while saved-auth login keeps no client/abort handle (`:381-406`).
- The adapter constructs `new Zalo({ logging: false, selfListen: true })` without
  a per-attempt polyfill (`apps/zalo-account-gateway/src/runtime/zca-client.ts:334-354`).
  In pinned `zca-js@2.1.2`, `Zalo.loginQR` copies the constructor options into a
  new context (`node_modules/.pnpm/zca-js@2.1.2/node_modules/zca-js/dist/zalo.js:74-83`),
  and every request calls `ctx.options.polyfill(url, options)`
  (`.../dist/utils.js:247-265`). The SDK's own QR `abort` action only controls
  its private controller and rejects its promise (`.../dist/apis/loginQR.js:234-255`);
  initial QR requests do not carry that signal (`.../dist/apis/loginQR.js:15-34`),
  while only waiting-scan/confirm do (`:119-142,155-181`). A fake-fetch check
  alone therefore does not prove that runtime cancellation reaches every phase
  or that the original login promise has settled.
- `finish()` invalidates state, calls `listener.stop()`, and releases the lease
  without awaiting a physical close (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:640-685`).
  The pinned listener calls `ws.close(1000)` and returns immediately
  (`.../dist/apis/listen.js:363-367`); its `closed` callback is delivered later
  from the WebSocket close handler (`.../dist/apis/listen.js:123-139`). The
  existing `stopAndWait` only waits for the gateway command result
  (`packages/business/src/zalo-account/transport.service.ts:215-240`), so an
  applied result can precede the actual socket close.
- Even after a passive close, all data callbacks are guarded only by `generation`
  (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:421-470,716-723`).
  Reconnect reuses that generation (`:482-517`), so an old listener's late
  message/status callback can still pass the queue check and publish after the
  close or after the replacement listener. The close itself bypasses that queue
  (`:432-434,482-494`), so lifecycle/data ordering is also not defined.

Failure: a timeout, cancellation, or lease loss can release ownership while a
login request or WebSocket is still live. Another gateway can acquire the same
lease, while the old promise/socket later attaches, publishes `connected`, or
publishes stale data. The planned `socketAttempt` guard covers the named close
callbacks, but the plan does not require that attempt identity gate every data
callback, nor does it define an awaitable login-settlement/physical-close
barrier. The plan's “no `Promise.race`” rule is necessary but insufficient if a
timed-out promise is merely detached.

Minimal plan correction: specify a per-attempt cancellable client handle whose
polyfill merges one signal into *all* SDK requests and whose QR handle invokes
the SDK `actions.abort` exactly once; require `finish` to invalidate first,
abort, await login settlement, and await an attempt-scoped `closed`/close-grace
before releasing the lease or reporting `stop` applied. Require the same
`(generation, socketAttempt)` check at callback admission and queue execution
for messages/status/undo/group events, and sequence close/data through one
ordering path. Add assertions for pre-QR HTTP, saved login, waiting scan/
confirm, late data callbacks, and physical close confirmation.

### High — 3000/3003 “hold/manual intervention” is not durable, so restart/reconcile can thrash the same auth

Plan locations: `phase-02-socket-runtime-and-session.md:53-64,76-81,183-206,208-220`; `phase-03-safe-status-api-and-ui.md:30-51`.

Evidence:

- The current close policy has no code input: the adapter maps only the reason
  string (`apps/zalo-account-gateway/src/runtime/zca-client.ts:75-78`), and the
  runtime treats every passive close alike, records an in-memory retry decision,
  and schedules another same-auth login (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:482-518`).
  `ReconnectPolicy` stores only process-local `closes` and `attempts`
  (`apps/zalo-account-gateway/src/runtime/reconnect-policy.ts:1-37`).
- A terminal/hold path releases the lease and destroys the runtime ownership;
  `finish` clears the runtime and releases the lease (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:640-685`),
  and pool stop/removal is likewise process-local (`apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts:123-134`).
- Recovery selects every account whose shared Connection is `connected` or
  `degraded` (`packages/database/src/repositories/integration-zalo-account/repository.ts:248-280`).
  `loadRuntimeAccount` then only checks that the account exists and decrypts
  authorization; it does not read a hold or Connection eligibility
  (`packages/business/src/zalo-account/service.ts:159-175`).
- The worker currently projects only the coarse lifecycle state, not the close
  code/hold reason (`apps/worker/src/events/zalo-account/handler.ts:90-106`),
  and maps `closed` to a transient failure and `reauthorization_required` to
  auth revoked (`packages/business/src/zalo-account/runtime-state.service.ts:11-23`).
  Thus a 3003-specific “keep degraded, do not reauth” outcome has no durable
  distinction from ordinary closed/retry behavior.

Failure: after a gateway restart or Redis lease loss, the in-memory circuit is
gone. A 3000 duplicate or 3003 kick that was supposed to hold is still selected
by the active-account query, and recovery can immediately reconnect with the
same credentials. Repeated restart/reconcile cycles can recreate the exact
auth-thrash that the plan says to prevent; mapping it to `reauthorization_required`
would instead violate the explicit “3003 is not revoked without evidence” rule.

Minimal plan correction: make the hold a fenced, durable value in the existing
`operations.runtime` snapshot (or an equally explicit existing durable status
reason), carry the normalized code/category into the worker's fenced update,
exclude held accounts from automatic recovery, and define the manual-reconnect
CAS that clears the hold. Test a process restart and Redis lease loss between
the hold write and the next reconcile; test 3000 and 3003 separately from
ordinary 1000/1006 retry.

### High — startup and Redis recovery are not actually bounded/resumable, and the current cursor contract cannot provide fairness

Plan locations: `phase-02-socket-runtime-and-session.md:76-87,132-152,183-206,216-238`; top-level acceptance `plan.md:45-55`.

Evidence:

- The gateway currently connects Redis, then awaits the entire reconciliation
  before starting the command consumer or listening for HTTP
  (`apps/zalo-account-gateway/src/main.ts:112-131`). `/readyz` cannot become
  reachable until that sequence completes (`apps/zalo-account-gateway/src/main.ts:104-110`).
- `reconcileActiveAccounts` returns only a number and awaits each reconnect in
  a keyset loop (`apps/zalo-account-gateway/src/runtime/reconcile-active-accounts.ts:5-43`).
  It has no deadline, timeout, continuation token, per-account outcome, or
  partial-page cursor. `pool.reconnect` itself awaits secret loading and the
  provider login (`apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts:90-119`;
  `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:381-406`).
- Redis has an error listener but no gateway recovery orchestration
  (`packages/redis/src/redis-client.ts:14-26`). If the consumer loop fails, main
  only marks `transportFailed` (`apps/zalo-account-gateway/src/main.ts:119-122`);
  lease-renew failure stops a runtime (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:265-286`),
  and no later Redis-ready hook invokes reconciliation.

Failure: a slow provider login blocks both command consumption and readiness,
contrary to the acceptance gate. On a Redis outage, leases expire and runtimes
stop, but the process has no bounded, coalesced trigger to restore them when
Redis returns. A proposed “one continuation” is not implementable from the
current return type: if a deadline occurs mid-page, `afterId` is assigned only
after the whole page (`reconcile-active-accounts.ts:19-39`), so retrying repeats
the page, while a slow first account can starve later accounts on every bounded
run. Repeated restarts can therefore either miss accounts or repeatedly retry
the same prefix.

Minimal plan correction: start/listen and start the consumer once Redis is ready,
then run reconciliation as a detached, coalesced task with an explicit global
budget. Define a return shape containing `afterId`, `truncated`, and per-account
outcomes; advance the cursor at a documented fairness boundary (including
partial-page cancellation), cap pages/accounts per Redis-ready generation, and
define one Redis `ready`/consumer-recovery trigger with backoff and no overlapping
run. State how commands and reconciliation share the existing pool key lock.
This supplies a bounded supervisor in `main` without adding a queue or service.

## Verification note

The pinned SDK version was read from `apps/zalo-account-gateway/package.json`
(`zca-js: 2.1.2`) and the resolved package under
`node_modules/.pnpm/zca-js@2.1.2/node_modules/zca-js`. The plan's cited
`reports/tdd-test-matrix.md` and `reports/design-contract.md` were not present
in the report directory at review time; no claim here relies on those absent
artifacts. `phase-04-regression-and-rollout.md` was also not present when the
review was written.

Status: DONE_WITH_CONCERNS
Summary: Three high-severity lifecycle/recovery gaps remain in the plan: no
awaited abort/physical-close ownership boundary with complete attempt fencing,
no durable 3000/3003 hold, and no executable startup/Redis recovery contract
with fair resumable cursors.
Concerns/Blockers: The exact cancel-handle and close-confirmation API, durable
hold representation/clear path, and Redis-ready reconciliation trigger must be
specified before implementation can safely claim the P0.1 acceptance gate.
