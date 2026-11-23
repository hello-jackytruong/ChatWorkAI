# TDD test matrix — P0.1 Zalo connection/socket/session

Ngày lập: 2026-11-23. Đây là matrix được duyệt trước implementation. Kết quả thực thi từng nhóm, RED/GREEN và gates còn mở nằm tại [final verification](./final-verification.md). Phần commands/scenarios bên dưới giữ làm contract gốc; không đọc các mô tả baseline như kết quả verification hiện tại.

Tại thời điểm lập kế hoạch, lệnh dưới đây là lệnh tương lai; baseline research có
đếm test hiện hành nhưng chưa có behavior mới. Không dùng credential/provider
thật. Characterization hiện hữu phải GREEN; behavior mới trong mỗi row có RED assertion trước GREEN và regression assertion sau REFACTOR.

## Checklist 17 rows

| # | Checklist / phase | Test owner và scenario | Expected assertion observable |
|---:|---|---|---|
| 1 | QR login/reconnect/disconnect, UID verification — P2 | `apps/zalo-account-gateway/__tests__/zalo-account-runtime.test.ts`; QR generated → scanned → credentials, saved login, wrong `getOwnId`, stop/cancel | UID phải match trước connected/auth; disconnect stop/release; wrong UID chỉ reauth evidence; no late API attach. |
| 2 | Lease/fence, multiple gateways, stale callbacks — P1/P2 | `zalo-account-runtime.test.ts`, `account-lease-store.test.ts`, SDK order test; same epoch old socket callback and lower fence event | only current owner/fence/attempt/sequence can publish/apply; stale event no DB/realtime. |
| 3 | Reconnect backoff/jitter/limit — P2 | `reconnect-policy.test.ts`; 1006 flaps, short open then close, 5-close window | one timer/account, bounded proposed delays/jitter; short open does not reset circuit; limit holds/manual. |
| 4 | `connected` only after true SDK open — P2 | runtime fake `listener.start()` then delayed SDK `connected`; close-before-open | no connected state/event before callback; exactly one connected after open. |
| 5 | Connection vs gateway runtime vs Zalo socket — P3 | business status service with Connection connected/degraded, lease present/missing, durable connected, Redis diagnostic match/miss | legacy `status` and `gatewayAvailable` remain; `socketOpen` true only matching open sample, null on new lease/no match. |
| 6 | connected/disconnected/closed/error — P1/P2 | `zca-client.test.ts`, runtime tests emit every SDK listener event, duplicate disconnected+closed | ports preserve code/category; one close decision; error is safe category; no raw reason/log. |
| 7 | Safe close code/reason: manual/network/duplicate/kick/expired — P2 | runtime policy cases 1000 local/unexpected, 1006, 3000, 3003, unknown | safe reason/code only; manual release/no retry; duplicate/kick hold/manual; no raw provider text. |
| 8 | Policy 1000/1006/3000/3003, contention — P2/P4 | policy + pool + restart/reconcile fixture | 1000/1006 transient policy bounded; 3000/3003 do not same-auth thrash; supervisor hold survives short open/restart. |
| 9 | Transient login vs auth loss; no QR for network — P2 | fake login rejects AbortError/ETIMEDOUT/5xx/unknown vs explicit rejection/UID mismatch | transient retries/holds; only explicit rejection or mismatch enters reauth; no QR for network/timeout. |
| 10 | Login/socket timeout; stuck runtime — P2 | fake fetch never resolves, fake listener never opens, stop/cancel at boundaries | attempt-local abort reaches request; watchdog clears; no Promise.race leak; one retry/one in-flight; late result stopped. |
| 11 | Latest connect/disconnect/reconnect count/next/error — P3 | `runtime_diagnostic` connecting/open/backoff/error/close sequence; status projection | operations.diagnostics latest safe phase/count/next/error; stale ignored; public fields allowlisted/null-safe. |
| 12 | Last SDK event time semantics; silence ≠ disconnect — P2/P3 | SDK message/typing/group events update in-memory timestamp; renewal at most 30s writes diagnostic; no close | `lastEventAt` is sampled SDK event time; no per-message DB/stream; no close inferred from stale timestamp. |
| 13 | Realtime status + polling fallback — P3/P4 | protocol workspace event `{accountId}`, guest batch, builder provider disconnect/miss, 30s status query | guest rejects; UI invalidates matching status key only; polling remains authoritative fallback; no diagnostics in event. |
| 14 | Gateway/Redis/worker restart recovery — P2/P3/P4 | bounded keyset page, Redis missing/lease mismatch, worker replay, startup slow account | only active connected/degraded eligible rows reconnect; bounded page/deadline/one coalesced bounded recovery timer; no infinite scan, queue, or manual revival. |
| 15 | Cookie/session refresh encrypted — P2/P3 | fake adapter cookie change after verified open; encrypted account event + ciphertext-fingerprint CAS race | only encrypted AAD path; UID/workspace/inbox/current active Connection + expected ciphertext fingerprint; newer auth wins; no cookie endpoint/updatedAt check. |
| 16 | QR generated/scanned/waiting/declined/expired/cancelled — P1/P2 | adapter SDK QR callbacks, cancel before first callback, declined abort, expiry retries, late GotLoginInfo | generated secret encrypted; scanned advances wait; declined provider_denied; SDK-expiry failed/errorCode=expired or real deadline status=expired; cancelled guard; no late auth/session overwrite. |
| 17 | Internal login/loginQR/getOwnId/getCookie/getContext/keepAlive boundary — P1/P2 | adapter/SDK-shaped fake verifies methods stay internal; fake context/cookie/getCookie and keepAlive failure | login and identity are internal; cookie/context absent status/log/realtime; keepAlive not polled; cookie refresh only proof-gated encrypted path. |

## Detailed scenario assertions

| ID | Phase | Given/when | Then |
|---|---|---|---|
| T01 | P1 | old lifecycle event lacks attempt/sequence | new reader uses fence/epoch/time/state-rank fallback. |
| T02 | P1 | lower fence has larger sequence | lower fence is rejected. |
| T03 | P1 | QRCodeDeclined includes provider code | adapter maps safe `declined` and calls abort once; code is not public. |
| T04 | P1 | encrypted authorization transport | ordinary lifecycle schema cannot accept auth/cookie fields; AAD still matches. |
| T05 | P2 | `listener.start` returns without open | runtime remains connecting; no connected transition. |
| T06 | P2 | open callback arrives | socketOpen true and one connected lifecycle. |
| T07 | P2 | old listener callback after replacement, same generation | attempt fence drops callback. |
| T08 | P2 | disconnected then closed | only one close/retry and one safe snapshot. |
| T09 | P2 | stop while `login(auth)` waits | AbortSignal reaches fake fetch; API result is stopped, not attached. |
| T10 | P2 | stop physical close has no immediate SDK closed callback | bounded acknowledgement/timeout holds manual; no second listener. |
| T11 | P2 | unexpected 1000 | transient retry, unlike local manual 1000. |
| T12 | P2 | 1006 burst | jitter/backoff and circuit limit apply. |
| T13 | P2 | 3000 duplicate | hold/manual, no immediate same-auth retry. |
| T14 | P2 | 3003 kick signal | hold/degraded; no automatic needs_reauth without further evidence. |
| T15 | P2 | login network timeout | transient category, no QR. |
| T16 | P2 | explicit provider rejection/UID mismatch | reauth path only. |
| T17 | P2 | QR cancel before first QR callback | abort/cleanup; late callback cannot publish QR/auth. |
| T18 | P2 | QR decline after scanned | abort once; guarded terminal provider_denied; duplicate terminal is no-op. |
| T19 | P2 | QR expiry retries | max existing pre-scan retry count then failed/errorCode=expired; actual session deadline expired; no unbounded retry. |
| T20 | P2 | lease lost during login/listener | generation invalidates; stop/abort/release; stale callbacks ignored. |
| T21 | P2 | paused/needs_reauth/disconnected account in reconcile | no provider login; no status revival. |
| T22 | P2 | slow first recovery account | server/consumer readiness is independent; one global deadline/cursor bound. |
| T23 | P2/P3 | SDK cookie changed after matching UID/open | encrypted refresh carries expected ciphertext fingerprint, never plain payload. |
| T24 | P2/P3 | stale refresh races newer QR ciphertext | CAS returns conflict/no overwrite/no retry storm. |
| T25 | P3 | diagnostic transition `backoff` | operations.diagnostics updates without Connection transition. |
| T26 | P3 | accepted `connected` lifecycle | Connection transition + runtime row commit, then one ID-only realtime. |
| T27 | P3 | stale lifecycle | no row/quota/realtime mutation. |
| T28 | P3 | SDK message at high frequency | only in-memory timestamp; renewal sample ≤ one/30s proposed. |
| T29 | P3 | durable connected event from new lease, Redis diagnostic absent | status socketOpen null; not active solely from lease. |
| T30 | P3 | Redis diagnostic fence/epoch mismatch | socketOpen unknown/not verified; no durable overwrite. |
| T31 | P3 | Redis unavailable | gatewayAvailable false, status runtime safe/null, no throw/raw error. |
| T32 | P3 | status action query | superAdmin enforced; group list not invoked. |
| T33 | P3 | groups dialog active | full operations `{status,groups}` remains available and controls work. |
| T34 | P3 | status hook 30s | only status route/action is polled per row. |
| T35 | P3 | realtime for account B while A mounted | only B key invalidated; no A refetch/QR close. |
| T36 | P3 | guest realtime batch includes status event | schema rejects and guest delivery excludes it. |
| T37 | P3 | old builder receives new event | unknown event ignored; polling still updates. |
| T38 | P3 | public status/API spec generated | legacy fields stable; runtime optional/null; no secret/raw reason. |
| T39 | P4 | worker replay after restart | fence/sequence idempotence; no duplicate transition/realtime. |
| T40 | P4 | all 17 rows reviewed | each row links to test owner and assertion; unresolved live proofs remain gating. |

## Assertions bổ sung sau review

| ID | Phase | Given/when | Then |
|---|---|---|---|
| T41 | P1/P2 | QR round1 expires; round2 uses fresh client; late same-UID GotLoginInfo round1 | ignored by generation+attempt; SDK abort once; no old auth write. |
| T42 | P2/P3 | generic same-UID QR reconnect commits new ciphertext before old refresh | expected fingerprint CAS rejects old refresh; no change generic binding. |
| T43 | P2/P3 | new Redis lease acquired but durable fence claim delayed | no provider login until durable claim; old queued lower-fence refresh rejected after claim. |
| T44 | P2 | 3000/3003 hold committed then process+Redis restart | hold still in DB, recovery skips same auth; explicit new QR clears only matching old hold. |
| T45 | P2 | abort before QR, waiting scan, waiting confirm, saved-login, physical-close timeout | actual request cancelled/settled; no false stop applied or replacement socket. |
| T46 | P2 | Redis ready fires repeatedly; consumer loop still alive; slow first account | one recovery run/timer, one consumer; cursor advances per attempted account; later accounts reached. |
| T47 | P3 | ordinary member receives opaque accountId hint then requests status action | superAdmin action still denies; no UID/profile/diagnostics leaked in hint; guest rejected. |
| T48 | P3/P4 | new strict lifecycle metadata/type produced while old reader exists | deployment gate blocks producer until new reader installed; rollback drains before reader downgrade. |
| T49 | P2/P3 | high-rate message/typing/unsupported SDK events; quiet socket | timestamp memory-only, ≤one Redis sample/30s + transitions, zero per-event diagnostic DB/stream; quiet ≠ disconnected. |
| T50 | P3 | settings hidden, groups dialog closed, many status invalidations | no background polling/group fetch/socket per row; one coalesced invalidation timer; cleanup on unmount. |

| T51 | P2/P4 | many simultaneous account starts and repeated terminal QR sessions | max2 auth starts, no unbounded permit waiters; terminal maps/listeners/controllers return to bounded baseline after settlement. |

| T52 | P3/P4 | two real disposable-DB connections interleave fence/CAS/QR auth writes | deterministic winning ciphertext/order, wrong scope rejected, sibling JSON preserved; tests executed not skipped. |
| T53 | P3/P4 | N100 visible rows over30s plus repeated IDs and hidden-tab transition | bounded100 steady requests/200 targeted DB reads/100 MGET, no group polls; hidden/missing mount stops polling. |

## Commands (future only)

Focused commands follow `.agents/skills/testing-workflow/SKILL.md`; use one Vitest
worker and workspace-relative paths:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-pool.test.ts __tests__/reconnect-policy.test.ts __tests__/reconcile-active-accounts.test.ts __tests__/fenced-event-publisher.test.ts __tests__/zca-client.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-runtime-order.test.ts __tests__/zalo-account-transport.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account.service.test.ts __tests__/zalo-account-runtime-state.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/device-session-flow.test.ts __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-teardown.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/realtime-protocol exec vitest run __tests__/schemas.test.ts __tests__/stream.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-accounts-public-api.test.ts __tests__/zalo-account-manage-ui.test.tsx __tests__/zalo-account-connect-ui.test.tsx __tests__/zalo-accounts-ui.test.tsx __tests__/workspace-realtime-provider.test.tsx
```

Final implementation gate is sequential `pnpm lint`, touched-workspace
typechecks including `@chatbotx.io/database`, then affected workspace suites with
existing coverage thresholds; do not add threshold bypasses. Các baseline hiện hữu đã được researcher chạy (99 tests; xem runtime-research); chưa chạy test hành vi mới/build/migration.

## File/test ownership map

- SDK schemas/order: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/src/lib/zalo-account.ts` + three SDK tests.
- Adapter/runtime/fence/recovery: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/` + gateway tests.
- Durable status/auth: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/` + business/database tests.
- Session bridge: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/src/device-session-flow.ts` and `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/events/zalo-account/handler.ts` + worker/connections tests.
- Realtime/public/UI: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/realtime-protocol/src/schemas.ts`, builder Zalo feature/query/realtime validation/messages + protocol/builder tests.
