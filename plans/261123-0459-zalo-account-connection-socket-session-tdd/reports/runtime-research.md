# Zalo runtime research — connection, socket, and session

## Outcome

The smallest safe P0 implementation is an additive Zalo-only hardening of the existing
gateway adapter/runtime, transport schemas, worker projection, and existing status API.
Keep the current lease + epoch + callback-generation fence, `retryOnClose: false`,
bounded startup reconciliation, and 30-second polling. Do not add a generic supervisor,
a new status table, a second reconnect owner, or per-message timers.

## Verified current behavior and gaps

1. `zca-client.ts:75-78,183-186` subscribes only to `closed` (and drops the numeric
   close code), message/status callbacks, then starts the listener with
   `retryOnClose: false`. It does not subscribe to SDK `connected`, `disconnected`, or
   `error` events. `ports.ts:83-107` consequently exposes only `onClosed(reason)`;
   `ports.ts:109-135` has no stop/close, cookie/context, keep-alive, or lifecycle phase
   operation.
2. The SDK explicitly emits `connected`, `disconnected(code, reason)`,
   `closed(code, reason)`, and `error(error)` (`node_modules/zca-js/dist/apis/listen.d.ts:19-45`).
   `listen.js:119-144` emits these around WebSocket open/close/error. It uses close
   codes 1000, 1006, 3000, and 3003 (`listen.d.ts:19-28`), and `stop()` closes with
   1000 and clears the SDK ping interval (`listen.js:363-367,413-418`).
3. `zalo-account-runtime.ts:476-479` calls `listener.start()`, immediately changes
   state to `connected`, resets reconnect policy, and publishes connected. This is
   before SDK `onopen`/`connected`; a close-before-open can therefore publish `closed`
   followed by a false `connected`.
4. `handlePassiveClose` (`zalo-account-runtime.ts:482-519`) ignores the close code and
   reason, labels every passive close as `passive`, and applies the same retry policy.
   `reconnect-policy.ts:1-38` has useful bounded jitter and a five-close/five-minute
   breaker, but no close classification. It resets attempts only when runtime currently
   calls `connected()`.
5. Saved-auth login catches every error in `connectWithAuthorization`
   (`zalo-account-runtime.ts:381-407`) and requests reauthorization. A transient
   network failure or login timeout is therefore indistinguishable from lost/invalid
   authorization and can force an unnecessary QR flow.
6. QR handling (`zca-client.ts:299-332`, `zalo-account-runtime.ts:334-379`) maps
   generated/scanned/expired/credentials, but not SDK `QRCodeDeclined=3`. The SDK
   callback exposes `retry`/`abort` actions (`loginQR.d.ts:3-60`); its declined branch
   can leave the outer promise unresolved unless the caller invokes an action
   (`loginQR.js:324-341`). The current runtime has no terminal rejected/cancelled QR
   lifecycle state.
7. Existing generation/fence checks are strong for data callbacks:
   `isCurrent`/`eventContext` (`zalo-account-runtime.ts:689-710`) and
   `fenced-event-publisher.ts:324-389` reject stale lease/fence writes. However,
   data/QR events are serialized through `eventQueue` (`zalo-account-runtime.ts:716-723`)
   while `connected`, `closed`, and reauthorization are direct sink calls. Lifecycle
   events can reorder even when generation checks pass. `finish` increments generation
   before stopping (`:640-687`), which is correct, but old listener callbacks also need
   attempt/listener identity when a new listener is installed.
8. `stopApi` (`zalo-account-runtime.ts:725-736`) calls `api.listen(...)` again to get a
   no-op listener and stop it. That can register another adapter listener set before
   stopping; add a direct port-level stop/close path instead.
9. `loginQR` creates an internal `AbortController` and 100-second QR timeout
   (`node_modules/zca-js/dist/apis/loginQR.js:234-247,290-320`). The public API does not
   accept an external signal, and `Zalo.login`/`loginCookie` accepts credentials only
   (`zalo.js:45-72`). A runtime `Promise.race` timeout cannot cancel the underlying
   fetch/login. It can only invalidate generation and clean up a late API result.
10. The pinned context supports per-client `Options.polyfill: typeof fetch`
    (`context.d.ts:116-158`), and `utils.request` passes caller options to it
    (`utils.js:247-265`). A contained adapter can compose an attempt-local abort,
    but must release it after login so post-login calls remain usable. This is not a
    global abort; before the first QR callback, cancellation remains best effort.
11. `getCookie` returns the SDK CookieJar and `getContext` the entire internal context
    (`getCookie.js:1-8`, `getContext.js:1-4`), while `keepAlive` is only a request
    (`keepAlive.js:3-21`). Keep all three adapter-internal; existing encrypted auth/AAD
    fencing is in `fenced-event-publisher.ts:102-174` and the connections service.
12. The pool serializes by `runtime.kind:runtime.id` (`zalo-account-pool.ts:53-61,329-349`)
    and stop removes/cancels a runtime (`:123-134`). Preserve it; reuse bounded
    sequential startup recovery (`reconcile-active-accounts.ts:5-44`) and shutdown
    (`main.ts:36-123,133-190`).
13. Durable status is separate: business mapping (`runtime-state.service.ts:11-67`),
    lease-based `gatewayAvailable` (`zalo-account/service.ts:30-99`), and 30-second
    builder polling (`use-account-operations.ts:11-29`) expose no socket phase, event,
    reconnect count, next retry, or sanitized last error.

## Minimal design ranked by fit

| Rank | Approach | Fit / trade-off | Adoption risk |
| --- | --- | --- | --- |
| 1 | Extend existing adapter ports, runtime state machine, event schemas, worker projection, and status resource | Smallest change; preserves lease/fence, queue, polling, and production channels. | Low: pinned SDK and established contracts. |
| 2 | Add a Zalo-specific listener/session helper inside gateway | Isolates watchdog/classification but adds a boundary and duplicate state ownership. | Medium: more teardown paths. |
| 3 | Enable SDK retry or add generic supervisor | Conflicts with the single-owner fence and creates overlapping retry loops. | High: resource and ordering risk. |

Recommendation: rank 1 only. ZaloCRM confirms the event-ordering pattern (all four
events plus listener epochs), but its retry/logging behavior is not a reason to copy a second pool.

## TDD plan input (exact change and test surfaces)

### Phase A — adapter/port contract

Modify `apps/zalo-account-gateway/src/runtime/ports.ts` and `zca-client.ts` to carry
connected/disconnected/closed(code, reason)/error, capped reasons, QR decline/abort,
and direct `stop`/`close`. Keep cookies/context/keepAlive private. Tests: create
`apps/zalo-account-gateway/__tests__/zca-client.test.ts` with SDK-shaped events, numeric
codes, one error listener, QR decline, and idempotent stop.

### Phase B — runtime lifecycle, timeout, and reconnect policy

Modify `zalo-account-runtime.ts` and `reconnect-policy.ts`: `start()` means
`connecting`; only SDK `connected` means open and resets policy; `closed` is the
code-aware decision point for 1000/1006/3000/3003/unknown. Add one login/open watchdog
per attempt, clear it on success/close/finish, invalidate generation before cleanup,
and stop late login results without attaching/publishing. Serialize lifecycle events;
retain fence > epoch ordering and legacy time/state fallback for old events.

Tests: extend `apps/zalo-account-gateway/__tests__/zalo-account-runtime.test.ts` for
open/close ordering, stale login, lease loss, each code, QR decline, timeout cleanup,
single reconnect timer, and exactly-once terminal publication; extend policy tests for
classification/backoff reset and pool tests for stop-vs-login/one runtime per key.

### Phase C — session refresh and recovery

Modify only the gateway adapter/service integration needed to read the internal cookie
jar after verified open/reconnect and persist a changed authorization through a CAS that
checks the expected encrypted-auth revision plus current Connection/UID/lease-generation
fence. `packages/business/src/zalo-account/service.ts:177-209` currently encrypts then performs a plain
`updateAuthorizationAndProfile`; do not blindly reuse that path. Add an attempt-local
polyfill abort only if tests prove cancellation; otherwise retain documented best-effort
timeout. Do not expose context or schedule per-message keepAlive; reuse
`reconcile-active-accounts` and Redis lease recovery.

Tests: fake cookie mutation and assert encrypted save/no secret event; fake keepAlive failure
as transient; add restart/reconcile and lease/generation cleanup tests.

### Phase D — projection/status

Modify additive SDK lifecycle schema/order and worker handler, then status resource/API/UI
for the P0.1 observability/realtime scope:
`packages/sdk/src/lib/zalo-account.ts`, `apps/worker/src/events/zalo-account/handler.ts`,
`packages/business/src/zalo-account/runtime-state.service.ts`,
`packages/business/src/zalo-account/service.ts`,
`apps/builder/src/features/zalo-accounts/schema/resource.ts`,
`apps/builder/src/features/zalo-accounts/api/operations.ts`, and status component/query.
Keep projection redacted and polling as fallback; publish realtime account status with
safe phase/timestamps/retry/error fields. Tests: SDK order/transport, worker lifecycle,
business runtime-state, and builder status/UI tests.

## Close and resource policy

| SDK result | Runtime action |
| --- | --- |
| 1000 with explicit stop/cancel | terminal manual; clear timers, stop listener, release lease; no retry |
| 1000 without local stop | transient/passive bounded retry; do not infer auth loss |
| 1006 | network transient; existing jitter/backoff and five-close breaker |
| 3000 duplicate | stop and release ownership; no immediate same-auth thrash; surface duplicate |
| 3003 KickConnection | hold/manual interruption; preserve degraded state and do not auto-loop saved auth without concrete auth evidence |
| error/unknown/no close | redacted error + open watchdog; one bounded retry path |

Budget per runtime: one SDK listener, one lease-renew interval, at most one reconnect
timer, and one login/open watchdog. `finish` clears all timers/listeners; SDK stop clears
its ping. Do not add a timer per event or a second reconnect loop. Status stores only a
safe category/code and timestamps, never raw cookie/context or provider error text.

## Existing narrow verification commands

Observed baseline: gateway 5 suites/21 tests passed (0.9s); SDK 3/31; business 2/17;
worker 1/9; connections 4/21 (1.64s). Commands are suitable after each phase (one
worker avoids resource spikes):

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-pool.test.ts __tests__/reconcile-active-accounts.test.ts __tests__/fenced-event-publisher.test.ts __tests__/server.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account-runtime-order.test.ts __tests__/zalo-account-transport.test.ts __tests__/zalo-account.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-runtime-state.test.ts __tests__/zalo-account.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-teardown.test.ts __tests__/device-session-flow.test.ts __tests__/lifecycle.test.ts
```

## Limitations and risks

- SDK 2.1.2 has no public external login abort before its first QR callback; a
  `Promise.race` is not cancellation. Treat this as residual risk unless a per-attempt polyfill test proves it.
- SDK cookie-jar mutation during `keepAlive` is unspecified; verify before persisting
  through the existing encrypted service path.
- The public lifecycle schema lacks close code/sequence; add fields backward-compatibly and do not reinterpret old `closed` events as code-aware events.
- No live Zalo provider/network test was run; use SDK-shaped fakes, not credentials; provider policy/uptime remain unvalidated.

Status: DONE_WITH_CONCERNS
Summary: Current runtime has lease/generation fencing and bounded recovery, but it marks connected before SDK open, drops close/error lifecycle data, conflates network failure with reauthorization, and cannot fully cancel SDK login. A ranked additive TDD plan and exact test commands are provided.
Concerns/Blockers: Pinned SDK 2.1.2 does not expose external login cancellation or define cookie mutation semantics; preserve generation fencing and document best-effort timeout unless adapter-local polyfill tests prove safe cancellation.
