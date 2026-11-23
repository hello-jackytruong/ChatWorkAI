# Implementation evidence — P0.1

Date: 2026-11-23. Branch: `feat/zalo-account-socket-session`. No migration, commit, push, or deploy performed. Other untracked plans preserved.

## Current handoff

Implementation phases1–3 are complete. Current evidence and open gates: [final verification](./final-verification.md), [runtime](./runtime-implementation.md), [business/PostgreSQL](./business-implementation.md), [UI/API](./ui-implementation.md), [production/public regressions](./production-regressions.md).

Latest focused results: gateway93, SDK40, business38, worker19, builder42 and real PostgreSQL11 executed/pass with0 skipped. Separate regression set174 passed. All8 affected-workspace typechecks and full `pnpm lint` pass after final fixes. Full workspace coverage is being checked with unchanged80% thresholds; coverage failures are not hidden or called complete. Live provider/restart/CLI-MCP gates remain open.

The phase notes below preserve intermediate RED/GREEN history; their earlier counts are not the final totals.

## Phase 1

- Existing SDK 31 tests and runtime/publisher 16 tests passed before edits. New order, diagnostic transport, adapter lifecycle/decline and publisher observation tests failed for missing behavior before implementation.
- Added optional attempt/sequence metadata with legacy comparator fallback; strict diagnostic schemas, encrypted refresh metadata; adapter lifecycle mapping and safe categories. SDK focused set: 35 tests passing.
- Gateway/SDK typechecks passed. First simplifier and invariant review passed.

## Phase 2

- New open-gate and stale-callback tests observed RED, then GREEN. SDK-pinned fake-fetch integration proves abort+settlement before first QR, logininfo, verify-client, generate, scan and confirm. Real pinned SDK QR/request/getCookie factory confirms cookie mutation through HTTP Set-Cookie. No live provider claim.
- Stop now awaits physical close callback; timeout retains a pool tombstone. Stop/acquire race regression found during review, fixed and tested. Local-capacity retry has watchdog and no provider failure charge; max two auth starts tested. Terminal session maps are evicted after operations/cleanup settle.
- Duplicate/kick holds remain degraded and persist against ciphertext identity; no automatic revocation from unknown login error. Every retry reloads current eligibility and auth; changed cookies may refresh after each verified open.
- Refresh keeps one private source/current ciphertext link in latest diagnostics so a later hold from that same live runtime binds to the refreshed ciphertext. Generic QR replacement cannot satisfy that link. No history or new schema column.
- Close/backoff are one ordered lifecycle event with atomic diagnostic metadata; prevents duplicate sequence dropping retry details. Admission-close and execution-close guards are distinct, preserving already-admitted FIFO events.
- Recovery HTTP/consumer readiness is independent of account login. Bounded cursor scan skips durable-held auth and continues after failures. A main test observed RED: 102 failing-consumer restarts in 100ms; fixed to a single continuation after 30 seconds, now GREEN. Periodic continuation makes a separate dirty flag unnecessary.
- Initial recovery passes an absolute deadline through claim/secret read and computes remaining login time immediately before provider login. Transaction reads re-bound statement/lock timeouts against that deadline; no abandoned HTTP Promise.race.
- User authorized Docker dev PostgreSQL and requested starting it. Started existing `chatbotx-postgres-1` via `docker compose start postgres`; existing schema confirmed. `.env` points to local Docker DB (`localhost:5432`, database `chatbotx`). No migration executed. Fixture User/Workspace/Inbox/Connection/Account are unique and cleaned.
- Real PostgreSQL race suite: **4 executed, 0 skipped**, two connections with pg_blocking_pids barriers: duplicate event once; old fence queued behind claim rejected; same-UID new QR beats stale refresh; hold survives owner change and only replacement ciphertext clears it.
- Latest full gateway suite: **18 files / 87 tests passed**. Existing Connection QR/runtime/teardown: **14 tests passed**. Focused business: 21 tests; worker: 11 tests (latest runs being reconciled).
- Independent review raised seven concrete issues; mechanisms fixed, reviewer reran 22 gateway tests successfully. Three follow-up issues (remaining deadline, refresh reset per attempt, preservation of diagnostics on error) subsequently fixed and regression covered. Full verification, coverage, final review and rollout docs remain Phase 4 gates.

## Not claimed

Live Zalo login/kick/restart staging behavior is untested. No production runtime started. Phase3 UI/status is implemented and locally tested. Full coverage and live gates remain in Phase4; no claim of production readiness. See current final verification rather than intermediate counts above.
