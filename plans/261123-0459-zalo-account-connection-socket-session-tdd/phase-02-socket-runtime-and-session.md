---
title: "Phase 2: Socket runtime và session"
status: completed
phase: 2
priority: P0
effort: "10-14h"
dependencies: [1]
---

# Phase 2 — Socket runtime và session

## Mục tiêu và dependency

Biến contract Phase 1 thành lifecycle đúng: bind listener trước `start`, chỉ
publish `connected` sau SDK `connected/open`, một close decision cho mỗi socket
attempt, dừng thật khi stop/cancel/lease loss, và reconnect có backoff/close-code
policy bounded. Phase này phụ thuộc Phase 1 đã xanh, nhưng vẫn chỉ sửa gateway,
worker/session và encrypted authorization path; không sửa global Connection
state machine, media/history, queue mới hay SDK dependency.

Evidence chính: runtime hiện đánh dấu connected ngay sau `listener.start()`
(`../../apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:409-480`),
chỉ nhận reason text và bỏ close code (`:482-519` cùng file), SDK đã phát
connected/disconnected/closed/error (`../../apps/zalo-account-gateway/node_modules/zca-js/dist/apis/listen.js:98-144`),
và `stopApi` hiện tạo listener thứ hai chỉ để stop (`../../apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:725-736`).
Pool đã serialize theo runtime key và cancel pending (`../../apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts:53-134,329-387`),
nhưng `loadRuntimeAccount` mới kiểm tra account tồn tại, chưa kiểm tra Connection
status (`../../packages/business/src/zalo-account/service.ts:159-175`).

## Requirements / data flow

1. **Attempt lifecycle:** `pool.startQr/reconnect` tạo nhiều nhất một runtime
   active/key. Runtime tạo `socketAttempt`, đăng ký listener callbacks với
   attempt token trước `listener.start()`, phát `connecting`/snapshot nội bộ,
   rồi chỉ khi `onConnected` đến mới set `state=connected`, reset policy theo
   stable-open rule và publish lifecycle connected. `getOwnId`/UID check vẫn
   trước durable account activation; mismatch là auth evidence.
2. **Exactly-once close:** `onDisconnected`, `onClosed`, `onError`, open
   watchdog và `finish` cùng đi qua một guard `(generation, socketAttempt,
   closeDecision)`. Callback cũ phải fail cả attempt check dù epoch/fence vẫn
   giống; close trước open không được sinh connected sau đó. Invalidate attempt
   trước `listener.stop()`/abort; stop idempotent.
3. **Timeout/abort:** mỗi attempt có tối đa một login/open watchdog và một
   `AbortController` cục bộ. Proposed defaults để test/ops chốt: saved-auth
   login 30s, socket-open 15s, QR session dùng deadline của ConnectSession/SDK
   quan sát được (không hứa cố định 120s), existing session TTL 5 phút giữ
   nguyên. Abort controller phải được đưa vào `Options.polyfill` wrapper của
   client đó; không monkey-patch global fetch, không `Promise.race` bỏ mặc HTTP.
   Clear controller/timer trước khi attempt kết thúc; late API result phải
   `stop` và không attach/publish.
4. **Single retry budget:** giữ `retryOnClose:false`; tối đa một reconnect
   timer/account và một login in-flight, không retry từ cả `disconnected` lẫn
   `closed`. Backoff/jitter hiện có (1s/5s/30s/120s, cửa sổ 5 phút) chỉ là
   proposed defaults cần test; không reset attempts trên open ngắn. Chỉ một
   stable-open observation (proposed 30s, tính khi close, không timer thêm) mới
   cho reset circuit.
5. **Close policy:**
   - local stop/cancel và explicit manual 1000: closed/manual, clear/abort,
     release, không retry;
   - unexpected 1000 hoặc 1006: transient network/closed, bounded jitter;
   - 3000 duplicate: closed/duplicate, release và circuit hold/manual
     intervention; không auto-thrash same auth;
   - 3003 kick signal: closed/kicked, hold/manual intervention, giữ
     Connection `degraded`; không tự gọi `needs_reauth` nếu chưa có explicit
     auth rejection/UID mismatch;
   - unknown/error/open-timeout: safe transient category; chỉ known provider
     rejection hoặc UID mismatch mới `reauthorization_required`.
   `disconnected` và `closed` của cùng attempt chỉ được chọn một policy.
6. **QR/session:** adapter map generated/scanned/declined/expired/credentials;
   scanned giữ `ConnectSession` ở waiting confirmation. Declined gọi SDK
   `abort`, cancel command gọi abort/stop và durable `cancel` guard; expired
   giữ retry count hiện tại, sau ngưỡng phát safe terminal. Worker chỉ decrypt
   QR/auth trong handler; declined → `provider_denied`, SDK expiry cạn retry → existing `connectSessionService.fail` với `errorCode="expired", statuses=["pending"]`; deadline ConnectSession thực sự dùng expiry rule hiện hữu. Cancel do user tiếp tục dùng guarded cancel hiện có. Terminal callback sau
   cancel/expire không được overwrite session; không thêm DB error code.
7. **Auth classification:** mọi exception qua allowlist `network|timeout|duplicate|
   kicked|provider_rejected|identity_mismatch|unknown`; `unknown` retry/hold,
   không QR. Redact trước `{ err: sanitizedError }`; không log raw Error,
   cookie, context, URL hay response body.
8. **Eligibility/recovery:** trước mỗi reconnect initial/recovery, service đọc
   current Connection cùng workspace/inbox/provider và chỉ cho
   `connected|degraded`; `paused|needs_reauth|disconnected`/manual không được
   revive. `listActiveRuntimeAccounts` vẫn keyset/page bounded. Runtime snapshot
   circuit hold được tôn trọng khi supervisor/reconcile chạy; manual reconnect
   là đường can thiệp rõ ràng.
9. **Startup:** Redis connect xong thì consumer/server readiness không chờ từng
   login. Reconcile chạy sequential page bounded với global proposed deadline
   (ví dụ 30s) và max page/count hiện có; kiểm tra deadline trước account kế,
   await attempt-local abort cleanup, trả cursor/truncated để có tối đa một
   continuation/recovery timer trong main, không queue/service mới; contract cursor/trigger/budget cụ thể trong design contract. Không nhân `loginTimeout × 1000`, không
   unbounded concurrency/full scan; account chậm không chặn command consumer.
10. **Secret refresh:** sau open + UID verification, chỉ khi SDK chứng minh
    cookie jar thay đổi mới tạo encrypted `authorization_obtained` cho account
    route với body refresh riêng đã được worker reader hỗ trợ. Event mang expected encrypted-authorization fingerprint/attempt metadata; worker
    decrypt rồi service kiểm tra workspace+inbox+UID, current Connection active,
    row-lock/CAS fingerprint của ciphertext `encryptedAuth` hiện tại và encrypt lưu.
    CAS miss giữ auth mới hơn, không retry ghi đè. Không dùng `account.updatedAt`
    vì group policy cũng bump; không expose cookie endpoint và không gọi
    `keepAlive` polling. Nếu pinned SDK không chứng minh được cookie mutation,
    không tự lưu/rollout refresh.

## File inventory (absolute; proposed)

**Modify — baseline files hoặc file đã tạo và GREEN ở phase trước:**

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/reconnect-policy.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/reconcile-active-accounts.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/ports.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zca-client.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/main.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zalo-account-runtime.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zalo-account-pool.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/reconcile-active-accounts.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zca-client.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/service.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/repository.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/schema/integration-zalo-account.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/events/zalo-account/handler.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-events.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/__tests__/device-session-flow.test.ts`

**Create — proposed:**

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/reconnect-policy.test.ts`

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/login-abort.integration.test.ts`

No migration, new queue, provider SDK file, or global connection enum may be
created. `login-abort.integration.test.ts` is a local fake-fetch proof, not a
live credential test; if it fails, stop Phase 2 at the explicit rollout gate.

## TDD sequence

1. **RED:** extend runtime/pool fixtures with SDK-shaped callbacks. Assert no
   connected event after `start` until `onConnected`; close-before-open, old
   listener callback, lease loss, stop-vs-login and duplicate `closed` all fail
   current behavior. Add policy tests for each close code and stable-open rule;
   add worker tests for declined/expired/cancelled terminal guards; add fake
   fetch test proving abort signal reaches actual request.
2. **GREEN:** implement attempt guard, direct listener stop, code/error mapping,
   watchdog/abort, one timer/login, QR abort/late teardown, eligibility check,
   bounded reconcile startup, encrypted CAS refresh. Preserve existing lease and
   event queue rather than adding a second supervisor.
3. **REFACTOR:** make finish the one cleanup owner; ensure all paths clear the
   same timer/controller/listener and publish at most one lifecycle decision.
   Keep policy pure/injectable clock/random; keep secret serialization in
   adapter/worker boundaries; redact before logger call. Review startup control
   flow so consumer readiness no longer waits on account login.
4. **GREEN/RED after refactor:** rerun focused tests with fake slow network,
   late callbacks, Redis lease loss, row CAS conflict and old transport events;
   any unbounded promise/timer, raw error, auth downgrade, or false connected is
   a release-blocking failure.

## Tests Before / Refactor / Tests After

**Tests Before (đầu Phase 2, sau Phase 1 GREEN; zca-client.test.ts đã được Phase 1 tạo, không phải baseline trước toàn kế hoạch):**

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-pool.test.ts __tests__/reconcile-active-accounts.test.ts __tests__/zca-client.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/device-session-flow.test.ts __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-teardown.test.ts
```

**Refactor/check:**

```bash
pnpm --filter zalo-account-gateway check-types
pnpm --filter @chatbotx.io/sdk check-types
pnpm --filter @chatbotx.io/business check-types
pnpm --filter @chatbotx.io/connections check-types
pnpm --filter worker check-types
```

**Tests After (lệnh tương lai):**

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-pool.test.ts __tests__/reconnect-policy.test.ts __tests__/reconcile-active-accounts.test.ts __tests__/zca-client.test.ts __tests__/fenced-event-publisher.test.ts __tests__/account-lease-store.test.ts __tests__/command-executor.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/device-session-flow.test.ts __tests__/zalo-account-runtime.test.ts __tests__/zalo-account-teardown.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account.service.test.ts __tests__/zalo-account-runtime-state.test.ts
```

## Scenario matrix

| Scenario | Expected assertion |
|---|---|
| `listener.start()` returns but SDK chưa open | Không state/publish connected; snapshot connecting. |
| SDK `connected` sau start | Một connected có attempt/sequence; socketOpen true; policy chỉ reset theo stable-open rule. |
| close trước open | Một closed decision, không connected muộn, listener/timer/abort được clear. |
| disconnected rồi closed cùng attempt | Chỉ một close/retry/lease action. |
| callback listener attempt cũ khi generation giữ nguyên | Bị attempt fence loại; không message/lifecycle/reattach. |
| 1000 manual vs 1000 unexpected | Manual release/no retry; unexpected transient bounded retry. |
| 1006 | Network category, jitter/backoff; không QR. |
| 3000 | Duplicate hold/manual; không immediate same-auth retry. |
| 3003 | Kicked hold/manual, Connection vẫn degraded; không tự needs_reauth nếu thiếu evidence. |
| Unknown error/open timeout | Safe transient; tối đa một retry timer và không raw error. |
| Explicit provider rejection/UID mismatch | Reauth path; only this evidence can require QR. |
| stop trong `login(auth)` | Abort thật tới fetch, login không attach; no late connected/auth. |
| cancel trước QR callback | SDK abort/cleanup; ConnectSession cancelled guarded; late GotLoginInfo ignored. |
| QR declined | `abort` once, worker terminal `provider_denied`, duplicate terminal no overwrite. |
| QR expires under existing retry budget | retry bounded; final `expired`, no infinite QR loop. |
| lease lost while socket/login pending | generation/attempt invalidated, listener stopped, lease released, stale callbacks ignored. |
| startup account takes longer than global deadline | server/consumer ready; current attempt cleans up; reconcile returns truncated/cursor, no ×N timeout. |
| recovery sees paused/needs_reauth/disconnected | `loadRuntimeAccount` refuses; no SDK login or manual revival. |
| newer same-UID QR ciphertext wins CAS | stale encrypted event returns conflict/no overwrite; no raw secret logged. |
| cookie mutation not proven by SDK | refresh path remains gated/blocked, no arbitrary cookie export or keepAlive polling. |

## Acceptance, security, resource và rollback

- Observable acceptance: no false `connected`; every active runtime has at most
  one lease-renew interval, one listener, one login, one watchdog, one reconnect
  timer; all cleanup tests inspect timer/listener/abort counts.
- Auth safety: UID/workspace/inbox/current Connection and expected ciphertext fingerprint are
  checked before encrypted refresh; CAS never uses `updatedAt`; raw secret only
  exists in internal encrypted path and is absent from status/log/realtime.
- Resource budget (proposed): one sequential reconcile page at a time, max
  existing page 100 and max existing 10,000, one global startup deadline, no
  unbounded continuation; one Redis lease read per account and no per-message
  DB/stream write. Default watchdog values are configuration estimates, not
  Zalo limits.
- Rollback: disable new runtime behavior behind the existing gateway deployment
  flag/old event reader, stop publishing new lifecycle metadata, and retain old
  comparator/status fallback. If abort or refresh proof fails, roll back only
  the new path and keep manual reconnect; never delete encrypted auth or revive
  Connection rows as rollback.

## Dependencies / unchecked / release gates

- Requires Phase 1 schema/port names and all old event fixtures green.
- `[GATING]` Fake-fetch test must prove `AbortSignal` reaches `utils.request`
  (`node_modules/zca-js/dist/utils.js:247-265`) and stops the actual login
  request. No live rollout with Promise.race-only behavior.
- `[GATING]` Pinned SDK cookie mutation/getCookie behavior must be proven before
  any automatic encrypted refresh; otherwise leave refresh disabled and report
  concern, not success.
- `[UNCHECKED]` Live Redis restart/latency, provider close-code frequency and
  authentication rejection shapes need staging evidence; no production claim
  is made from fakes.

## Chi tiết bắt buộc sau review

- Mọi callback data/lifecycle (message, group, receipt, typing, reaction, undo, unsupported) kiểm tra generation + socketAttempt lúc admission **và** lúc chạy eventQueue. Close cũng đi cùng ordering path; không chỉ fence onClosed.
- Port client có cancel/settled boundary; polyfill ghép caller signal với attempt signal cho tất cả SDK login HTTP, kể cả trước QR đầu tiên. Sau login thành công chuyển sang lifetime socket/client; không gắn request gửi tin vào controller login đã abort. SDK QR abort giữ đúng once.
- `finish/stop` invalidate trước, abort HTTP, await settlement/SDK close hoặc hết close-grace; không report stop applied khi chỉ mới gọi `listener.stop()` void. Với lease đã mất không thể giữ ownership: teardown ngay, callback fence vẫn bảo vệ, không claim physical-close đã xác nhận nếu chưa có event. Timeout close fail-closed, không cấp ack thành công để xóa auth hoặc attach socket mới.
- Hold 3000/3003 và exhausted-transient budget phải bền vững trong `operations.diagnostics` theo auth fingerprint. Dùng callback nội bộ gateway → business/repository hiện hữu (không direct DB), commit hold có fence trước khi chủ động release; persistence lỗi không báo stop/hold thành công. Recovery đọc hold kể cả Redis restart. QR reconnect thành công tạo ciphertext mới là đường clear hold; không thêm endpoint tự reconnect same-auth.
- Refresh CAS dùng fingerprint của **ciphertext** đang lưu, không revision chỉ tăng ở runtime (generic QR reconnect không tăng revision đó). Lock account/current Connection trong transaction, kiểm tra active + đúng UID/workspace/inbox và order; refresh cũ sau QR cùng UID phải bị loại. Không sửa helper saveAuthorization cho caller không liên quan.
- Recovery do startup + Redis-ready + lease-loss signal hiện hữu kích hoạt, coalesce trong main; chỉ một run và một continuation timer/gateway. Không đổi vòng consumer chung, không mở scheduler/BullMQ mới. Xem budget và cursor chính xác trong design contract.

## Tasks

- [x] Viết RED cho open gate, tất cả stale callback, dedup close và auth/transient classification.
- [x] Viết RED cho abort trước QR/scan/confirm, settlement và physical-close ack.
- [x] Cài behavior tối thiểu, giữ một retry owner và bounded retry/circuit hold.
- [x] TDD hold durable, recovery trigger/cursor fairness và ciphertext CAS race.
- [x] Chạy lại tests/cleanup counters; unresolved abort/close proof dừng thực thi tại gate, không giả hoàn thành.

QR retry tự động chỉ trước scanned và luôn dùng client/attempt mới sau abort+settled; giữ budget hiện có, không dùng SDK recursive retry với callback cũ. Sau scanned/declined thì terminal và UI retry tạo ConnectSession mới. Mọi callback QR/GotLoginInfo dùng generation+attempt, không chỉ UID.

Thứ tự ownership trước provider: Redis acquire → durable claim highest fence/epoch qua callback main→business → load current auth/hold → login. Secret refresh CAS và worker apply đều so với durable claim; lower-fence queued event sau takeover không thể ghi auth/state. Existing `loadRuntimeAccount`/pool tests phải sửa để không giữ secret lấy trước claim.

Inventory bổ sung bắt buộc theo design contract: runtime-state.service.ts và business tests; SDK key/schema đã thuộc phase1; gateway account-lease-store.ts/account-lease-store.test.ts cho snapshot atomic; command-executor.ts/command-executor.test.ts cho stop không false applied; pool fixtures/main callback wiring; database integration race test mới (opt-in, không apply migration). Reconcile trả cursor/outcomes theo contract, một coalesced ready/lease-loss trigger+timer trong main, max50 scanned/30s run và tiếp tục cursor.

Khi socket đang open, error event riêng lẻ chỉ cập nhật safe error, không tự coi là close và không tạo socket mới. Retain owned close/error handlers tới khi close confirmed, sau đó remove đúng owned listeners; không removeAllListeners gây hỏng SDK handlers nội bộ. Pool dọn map/attempt/controller cho session terminal chỉ sau pending operations đã settled; test churn không tăng map vô hạn. Global auth permit2 không chứa hàng đợi Promise không giới hạn: nếu bận thì defer qua một retry timer hiện có, chưa gọi provider và không tính là provider auth failure.

Connection `device-session-flow.ts`/`service.ts` là read-only reference và existing API consumer; không sửa generic implementation mặc định. QR terminalization ở nhánh Zalo worker/business dùng existing fail/cancel guards. Nếu phát hiện bắt buộc sửa shared helper, dừng tại evidence và chỉ thêm guard provider-specific cùng regression kênh khác, không đổi semantics chung.

Existing test inventory bổ sung: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/account-lease-store.test.ts` cho fenced snapshot và `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/command-executor.test.ts` cho stop acknowledgement/rejection. command-executor.ts là read-only consumer nếu Promise rejection hiện hữu đủ; chỉ modify khi compile/behavior test chứng minh cần, không tự thêm result union.
