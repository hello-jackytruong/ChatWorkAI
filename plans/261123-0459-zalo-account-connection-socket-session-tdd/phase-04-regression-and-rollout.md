---
title: "Phase 4: Regression và rollout"
status: in-progress
phase: 4
priority: P0
effort: "4-5h"
dependencies: [3]
---

# Phase 4 — Regression và rollout

## Mục tiêu và dependency

Đóng toàn bộ 17 checklist rows bằng regression matrix, shared-contract callers,
security/resource review và rollout/rollback gate. Phase tuần tự sau Phase 1-3;
không mở thêm feature, không làm media/recall/history, không chạy migration,
stage/commit hay claim live provider proof. Đây là phase kiểm chứng và phát hành
có điều kiện, không phải nơi sửa generic Connection/realtime semantics ngoài
event Zalo IDs-only đã được duyệt.

## Requirements / regression contract

1. Re-grep/re-verify mọi symbol trước khi implementation: gateway runtime/pool,
   SDK order/transport, worker handler, repository JSON/fence, status action/API,
   realtime registry/guest validator, query hooks/UI fixtures. Nếu line drift,
   cập nhật link; không copy stale report.
2. Trace caller graph đầy đủ: `zca-client → ports → runtime → pool →
   command-executor`; `FencedEventPublisher → Redis stream → worker handler →
   runtime-state service → repository/Connection`; `status service → public
   operations API/status action → hooks → manage/groups UI`; accepted lifecycle
   `→ queueWorkspaceRealtimeEvent → realtime protocol/delivery → builder cache`.
3. Shared contract touchpoints phải được test: SDK schema/order, transport
   publisher/AAD, default disabled sink, `RuntimeEventSink`/pool fakes, worker
   lifecycle fixtures, `RealtimeEventType`/`EVENT_DELIVERY`/`AllRealtimeEventData`,
   guest allowlist, builder validator/provider, public output/spec, UI mocks and
   edge import graph. Không thêm a global connection enum.
4. Verify backwards compatibility in mixed rollout: old gateway event without
   sequence/attempt is accepted by new worker comparator fallback; old row gives
   `runtime:null`; new ID-only realtime is ignored by old builder; new status
   fields optional/null; old full operations/groups caller unchanged.
5. Verify security: no raw provider error, URL, cookies, IMEI, user-agent,
   context, QR image, lease owner/fence/attempt/sequence in public status,
   realtime, log or test snapshot. Logger receives `{ err: sanitizedError }`
   only; auth remains encrypted/AAD-bound and CAS-protected.
6. Verify bounded resources: one socket/listener/lease renew/login/watchdog/retry
   timer per account, bounded Redis GET/status and event coalescing, bounded
   keyset recovery page/deadline/continuation. No per-message DB/stream write,
   no second queue/process, no full unbounded scan, no SDK keepAlive polling.

## File inventory (absolute; proposed)

**Modify — test đã có tại đầu Phase 4 (baseline hoặc được tạo ở Phase 1/2), chỉ khi cần thêm regression:**

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zalo-account-runtime.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zalo-account-pool.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/reconnect-policy.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/reconcile-active-accounts.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/fenced-event-publisher.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zca-client.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/server.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/__tests__/zalo-account.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/__tests__/zalo-account-runtime-order.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/__tests__/zalo-account-transport.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account.service.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-runtime-state.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/__tests__/device-session-flow.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/__tests__/zalo-account-runtime.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/__tests__/zalo-account-teardown.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/__tests__/lifecycle.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-events.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/realtime-protocol/__tests__/schemas.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/realtime-protocol/__tests__/stream.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-accounts-public-api.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-accounts-action-permissions.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-accounts-ui.test.tsx`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-manage-ui.test.tsx`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-connect-ui.test.tsx`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/workspace-realtime-provider.test.tsx`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/edge-instrumentation-graph.test.ts`

No new source file is required by Phase 4; any new fixture stays in the owning
test listed above. No migration/app/queue/global skill file is owned.

## TDD sequence

1. **RED — matrix audit:** run focused existing suites against Phase 3 output;
   add one failing assertion per uncovered checklist row, especially close
   code/stop acknowledgement, stale same-generation callback, mixed old event,
   QR terminal guard, startup deadline, CAS conflict, status redaction, guest
   rejection and no-group-poll. Mark provider/live cases as gating, not fake.
2. **GREEN — regression fixes only:** implement the smallest cause-aligned fix
   in phase-owned files, update all shared caller fixtures/maps, and keep public
   legacy fields. Do not weaken assertion or skip coverage to get green.
3. **REFACTOR — review:** use source re-grep, invariant checks (structured log,
   no DB in builder, i18n, edge Node graph, public API), inspect timer/listener/
   promise ownership, and remove any plan-only symbol from code. Confirm no two
   phases own a source file without a deliberate sequential handoff.
4. **GREEN/RED after refactor:** run affected suites, type/lint, coverage gate
   with existing thresholds, and mixed-rollout contract tests. Any GATING item
   unresolved keeps status `DONE_WITH_CONCERNS` and blocks live rollout.

## Tests Before / Refactor / Tests After

**Tests Before (đầu Phase 4, sau Phase 1–3 GREEN; gồm file đã được các phase trước tạo, không phải baseline trước toàn kế hoạch):**

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-pool.test.ts __tests__/reconnect-policy.test.ts __tests__/reconcile-active-accounts.test.ts __tests__/fenced-event-publisher.test.ts __tests__/zca-client.test.ts __tests__/account-lease-store.test.ts __tests__/command-executor.test.ts __tests__/server.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-runtime-order.test.ts __tests__/zalo-account-transport.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account.service.test.ts __tests__/zalo-account-runtime-state.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/device-session-flow.test.ts __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-teardown.test.ts __tests__/lifecycle.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/realtime-protocol exec vitest run __tests__/schemas.test.ts __tests__/stream.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-accounts-public-api.test.ts __tests__/zalo-accounts-action-permissions.test.ts __tests__/zalo-accounts-ui.test.tsx __tests__/zalo-account-manage-ui.test.tsx __tests__/zalo-account-connect-ui.test.tsx __tests__/workspace-realtime-provider.test.tsx __tests__/edge-instrumentation-graph.test.ts
```

**Refactor/check:**

```bash
pnpm lint
pnpm --filter @chatbotx.io/sdk check-types
pnpm --filter @chatbotx.io/realtime-protocol check-types
pnpm --filter @chatbotx.io/database check-types
pnpm --filter @chatbotx.io/business check-types
pnpm --filter @chatbotx.io/connections check-types
pnpm --filter worker check-types
pnpm --filter zalo-account-gateway check-types
pnpm --filter builder check-types
```

**Tests After / release gate (lệnh tương lai, chạy tuần tự sau focused GREEN):**

Preset coverage include toàn bộ `src/**/*`; không gắn `--coverage` vào một vài test rồi coi kết quả là coverage đầy đủ workspace. Chạy affected workspace suites tuần tự, một worker, giữ nguyên threshold 80% hiện hữu:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/realtime-protocol exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run --coverage
```

Nếu full suite/coverage có failure nền, ghi chính xác baseline/new regression, không hạ threshold/skip để gọi verified. Không chạy lại global cold types sau touched-workspace types đã xanh nếu không có bằng chứng mới. Không chạy `db:migrate`; DB-backed integration chỉ dùng môi trường opt-in đã được chấp thuận, không áp migration tự động.

Regression kênh production khác (focused, không sửa implementation các kênh):

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/lifecycle.test.ts __tests__/messenger-teardown.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo exec vitest run __tests__/connection-oauth.test.ts __tests__/refresh-access-token.test.ts __tests__/webhook-routing.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-messenger exec vitest run __tests__/connection-oauth.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/connection-status-message.test.ts __tests__/edge-instrumentation-graph.test.ts __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts
```

## 17-row acceptance cross-check

Chi tiết assertion ở [matrix](./reports/tdd-test-matrix.md); reviewer phải tick
từng row trước rollout: (1) QR/UID, (2) lease/fence/stale callback, (3) backoff,
(4) open gate, (5) three-state split, (6) connected/disconnected/closed/error,
(7) safe close, (8) close-code policy, (9) transient/auth, (10) timeout/stuck,
(11) latest connection/reconnect/next/error, (12) last event semantics,
(13) realtime+polling, (14) Redis/gateway/worker restart, (15) encrypted refresh,
(16) QR states, (17) internal login/loginQR/getOwnId/getCookie/getContext/keepAlive
boundary.

## Rollout sequence, rollback và observability

1. **Preflight:** all focused tests/type/lint/coverage green; review diff only in
   inventories; verify no secret in artifacts; prove abort polyfill and cookie
   refresh or explicitly disable/gate refresh. Use staging SDK-shaped fakes and
   Redis restart rehearsal; no real credentials in tests.
2. **Mixed deploy:** deploy reader/schema/status first (optional/null and legacy
   comparator), then worker projection/realtime + realtime gateway registry,
   then gateway adapter/runtime producer, finally builder status-only hook. Keep old clients supported; monitor counts of
   accepted/stale lifecycle events, duplicate close decisions, login aborts,
   open timeouts, circuit holds, CAS conflicts, Redis lease misses and status
   query/group query calls. Metrics labels are safe categories/account counts,
   never UIDs/cookie/error text.
3. **Canary:** one bounded gateway/account cohort, proposed observation window
   (e.g. 30 minutes; not a provider SLA). Verify connected only after open,
   no duplicate retry timer, no QR on network interruption, no revival of paused
   rows, and status null/legacy fallback under old event injection.
4. **Rollback:** first stop new realtime producer/UI subscription (polling still
   works), then disable gateway reconnect/refresh behavior while preserving
   manual stop/lease release, then roll worker/status readers back only after
   stream consumers tolerate new optional fields. Never delete operations JSON,
   cancel active sessions blindly, overwrite newer auth, or reset Connection
   status to revive accounts. If physical `listener.stop()` acknowledgement is
   unknown, hold/manual and fail closed rather than attach a new socket.

## Scenario matrix

| Scenario | Expected assertion |
|---|---|
| All 17 checklist rows | Matrix has owner test + observable assertion; no unchecked row silently accepted. |
| Old lifecycle event | New worker accepts legacy comparator and no secret/realtime leak. |
| New event to old client | Old builder ignores unknown event; 30s status poll remains usable. |
| Full API output | Legacy keys stable; runtime optional/null; public spec contains no secret. |
| Guest delivery | Zalo event rejected by guest schema and never routed to guest stream. |
| Ordinary member | Only ID-only workspace envelope, no diagnostics/action. |
| Gateway restart/Redis restart | Bounded keyset reconcile restores only connected/degraded eligible rows; no infinite/full scan. |
| Worker restart/replayed event | Fence/sequence rejects stale/duplicate; realtime only after accepted commit. |
| Slow account during startup | Consumer/server readiness unaffected; page/deadline/truncated continuation bounded. |
| Stop physical close delayed | No new attachment; bounded hold/manual path and no overlapping socket. |
| Auth refresh race | Newer QR ciphertext wins; older encrypted callback discarded. |
| Network flap/short open | Backoff/circuit not reset prematurely; no QR absent evidence. |
| 3000/3003 | Hold/manual, no same-auth thrash or automatic revoked claim. |
| Status panel closed/open | Row status hook does not query groups; full groups query only active panel. |
| Provider raw error | Sanitized category only in logs/status/UI. |

## Acceptance, security, resource and unresolved gates

- Success is observable only when all matrix rows and commands pass, legacy API
  fixtures pass, no new generic enum/table/service/queue exists, and a source
  audit confirms each caller. `DONE` is not granted for theoretical or live
  provider claims.
- Security review must confirm encrypted AAD includes workspace/subject/command/
  epoch/fence/attempt as applicable, CAS checks UID/workspace/inbox/current
  Connection, public projection strips secrets, and logger gets sanitized error.
- Resource review must count active listener, timers, abort controllers, Redis
  reads, lifecycle DB writes and realtime events under a repeated flap/restart
  test; no unbounded map/history or per-message sampling.
- `[GATING]` no proven SDK-local abort, cookie mutation semantics, close-code
  provider evidence, Redis restart timing or physical close acknowledgement →
  `DONE_WITH_CONCERNS` and hold live rollout/manual only.

## Docs / public contract / ownership

- [ ] Sau implementation, chạy skill `.agents/skills/cli-mcp-docs/SKILL.md` cho output status/public spec; cập nhật đúng generated API/CLI/MCP surface nếu schema đổi. Không thêm operation chỉ để đổi nhãn UI.
- [x] Cập nhật `docs/zalo-account.md` cho status/socket/QR/recovery behavior và quyền; cập nhật checkbox P0.1 trong `docs/zalo-account-checklist.md` chỉ khi có evidence hoàn tất.
- [x] Inventory phase 4 có test `zca-client.test.ts` và `reconnect-policy.test.ts` là file mới do phase 1/2 tạo, không giả định tồn tại ở baseline.
- [x] Rà invariant-guard sau source edits, security-review cho authorization/fencing, và reviewer cho shared contracts trước khi ship. Chưa có quyền commit/deploy/merge từ yêu cầu lập kế hoạch.
- [ ] Lưu kết quả RED/GREEN, focused/full gates, counters và live proof; bàn giao rollback có producer-first stop/drain, consumer-last downgrade.

Existing test inventory: `apps/zalo-account-gateway/__tests__/account-lease-store.test.ts`, `command-executor.test.ts` là bắt buộc trong gate cho snapshot/stop. DB integration gate ở Phase 3 bắt buộc pass trên DB disposable đã chấp thuận trước khi gọi CAS/fence verified; plain test suite skip không được tính pass concurrency.

## Current execution evidence

Implementation phases1–3 complete. [Final verification](./reports/final-verification.md) records all17 rows, all8 passing types, root lint, real PostgreSQL11/0skip and focused/regression results. Full workspace coverage currently fails80% in several workspaces despite passing behavior tests; keep gate open and do not lower thresholds. Generated public spec/MCP and CLI collision tests pass; live CLI/MCP unavailable without local builder. Provider/restart staging and release remain unperformed. Final review finding on retry diagnostic failure was fixed RED→GREEN and independently cleared.
