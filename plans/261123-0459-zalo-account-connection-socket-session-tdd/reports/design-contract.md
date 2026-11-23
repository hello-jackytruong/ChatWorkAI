# Design contract — P0.1 connection, socket và session

Ngày: 2026-11-23. Status thực thi: **pending**. Đây là thiết kế để triển khai TDD, chưa phải behavior đã chạy hoặc provider SLA. Khi phase mô tả ngắn, contract này là chi tiết thống nhất; không có quyền mở rộng sang media/thu hồi/history.

## Outcome, alternatives và phạm vi

- Chọn sửa các seam Zalo hiện hữu: adapter/ports → runtime/pool → fenced event → worker/business/repository → status API/UI. Không tạo app, deployment service, BullMQ queue, table/migration, connection enum hoặc SDK upgrade.
- Không chọn generic supervisor/Connection FSM rewrite: tăng blast radius cho kênh production mà không cần để sửa P0.1. Không bật SDK retry song song với runtime retry.
- Không chép pool/scheduler ZaloCRM. Dùng nó để tham khảo event mapping, QR UX và phân biệt DB/live status; giữ lease/fence của ChatbotX.
- Trade-off: hợp đồng xuyên SDK/gateway/worker/DB JSON/API/realtime/UI bắt buộc chạm hơn 8 file. Đây là additive mapping ở các boundary đã có, không phải nhiều feature mới. Không tạo thêm class/service độc lập; tối đa helper adapter/error-policy thuần nếu file hiện hữu thực sự quá phức tạp.
- Bốn phase là bốn gate tuần tự contract → runtime → API/UI → regression/rollout. Test nằm trong từng phase, không dồn TDD đến cuối; không chạy các phase song song.
- Biến thể thực đã xét: Zalo OA và Messenger cùng dùng Connection/realtime. Chúng giữ nguyên transition, reasons, routes và payload cũ; chỉ thêm variant Zalo Account trong protocol/worker. Regression OAuth/teardown/guest schema và Edge graph chứng minh boundary này.

## Nguồn bằng chứng

Xem [source inventory](./evidence-inventory.md), [runtime research](./runtime-research.md), [status research](./status-research.md). Runtime đang publish connected sau start; SDK phát onopen riêng. Transport payload tại `packages/sdk/src/lib/zalo-account.ts` dùng `.strict()`; thêm optional field vẫn có thể bị **reader cũ** reject. Repository đã có JSON operations và row-lock. Generic QR reconnect ghi ciphertext mới nhưng không tăng một counter riêng của runtime.

## 1. Vòng đời attempt và stop acknowledgement

1. Pool hiện hữu serialize key account/session; một runtime active/key. Mỗi login/socket mới có attempt token tăng dần, callback closure giữ `(generation, socketAttempt)`.
2. Đăng ký event trước start. `start()` chỉ là đang kết nối; `onConnected` của attempt hiện tại mới cho socketOpen=true và connected lifecycle.
3. Admission **và execution** của mọi callback message/group/receipt/typing/reaction/undo/unsupported/lifecycle đều kiểm tra generation+attempt. Close/data được serialize theo một thứ tự, không bypass queue rồi cho callback socket cũ chạy muộn.
4. `disconnected`+`closed`+error/watchdog cùng attempt chỉ có một close decision. `error` sau khi đã open không tự suy ra closed: ghi category an toàn; chờ close hoặc operation/deadline có bằng chứng, không mở socket thứ hai chỉ vì error đơn lẻ.
5. Cancel handle của client sở hữu controller và settlement promise. Polyfill của **client/attempt đó** compose SDK request signal + attempt signal cho mọi login HTTP, kể cả trước first QR. Không thay global fetch. Khi login xong tách timeout login khỏi lifetime của API gửi tin; không abort nhầm request sau login.
6. SDK QR actions.abort được giữ/call đúng once khi cancel/decline/timeout. Mỗi automatic QR retry trước scan dùng client mới + attempt mới, abort/await settlement attempt cũ; không gọi recursion actions.retry với cùng callback của SDK. Giữ tối đa hai lần retry như hiện tại. Sau scanned mà expiry thì terminal expired-code và user khởi tạo session mới, không reset shared ConnectSession step hoặc sinh QR ẩn sau scanned. Nếu cancel trước first callback, HTTP wrapper phải abort thật; callback về sau vẫn gọi SDK abort và bị fence. `Promise.race` chỉ dùng để giới hạn chờ cleanup có báo failure, không thay thế cancellation.
7. `finish` invalidate trước rồi abort, chờ login settlement và close-confirmation callback. `listener.stop()` void không phải physical-close proof. Chỉ ack stop applied khi resources settled/close confirmed. Nếu hết close grace: fail-closed, không xóa auth, không attach replacement hoặc báo thành công. Không truy cập private ws/patch SDK.
8. Khi lease đã mất, không thể giữ quyền sở hữu: teardown ngay, fence dữ liệu cũ, ghi rõ close chưa xác nhận nếu có. Không hứa tuyệt đối không còn physical socket trên network partition; ngăn socket cũ phát event/send bằng fence và chặn replacement trong cùng pool tới khi cleanup xác nhận.

Proposed timeout để test, không phải provider limits: login saved-auth 30s; open 15s; close grace tối đa 10s và nằm trong deadline stop/shutdown hiện có. Overall stop waiter phải lớn hơn cleanup budget hoặc trả timeout fail-closed, không false applied. QR deadline là min của session còn hạn và SDK callback deadline; SDK pinned QR timer100s, không gán countdown120s giả. Timeout dùng clock injectable/fake timers.

## 2. Retry, hold và manual recovery

| Evidence | Action | Connection business state |
|---|---|---|
| local stop/cancel/shutdown; code1000 do user | Stop, no retry | Existing manual/lifecycle path |
| unexpected1000,1006, network/timeout | One bounded backoff retry | Existing degraded when closed |
| 3000 DuplicateConnection | Durable hold, no automatic same-auth loop | Degraded, not revoked |
| 3003 KickConnection | Durable hold/manual intervention | Degraded, not automatic needs_reauth |
| known provider auth rejection / UID mismatch | Stop, require reauthorization | Existing auth.revoked/needs_reauth path |
| unknown login error | Bounded retry then durable hold | Degraded/unknown, not inferred revoked |

- Preserve existing jitter/backoff bases and cap. Count failed login/open attempts as well as passive closes; unknown failure must not retry forever just because no socket opened. Stable-open30s (computed at close, not separate timer) may reset budget; short-lived open does not.
- Hold is latest durable `operations.diagnostics.hold` with safe category, timestamp and **internal auth fingerprint**; no history list. A small callback wired in main to existing business/repository persists fenced hold before deliberate release. No direct DB in gateway. Persistence failure keeps the operation failed/held locally; never acknowledges successful stop/hold and then forgets it.
- `loadRuntimeAccount` rechecks provider/workspace/inbox/current Connection active and current hold before every automatic start. Recovery filters held accounts; a Redis/gateway restart must not clear durable hold.
- Existing explicit QR reconnect (Connection engine) writes a new ciphertext and is the trusted manual-clear signal. Hold applies only to the auth fingerprint it stopped; successful new QR auth may clear it under row lock. Same UID alone never clears hold. No new resume endpoint or automatic global status rewrite.
- A crash before any close event can be durably recorded is not magically atomic with Zalo; next observed duplicate/kick must re-establish the hold. Tests prove hold-after-commit survives restart and no acknowledgement precedes its commit.

## 3. Wire contract and durable diagnostics

Proposed names below are **new Zalo-specific** types/variants, not claims that symbols already exist.

- Keep `operations.runtime` and its old state union (`connected|closed|reauthorization_required`) as the legacy business lifecycle order. Do not repurpose it to mean connecting/backoff or call shared Connection transitions for diagnostic updates.
- Add optional typed `operations.diagnostics` in the existing JSON column. Internal order is `{fenceToken, epoch, socketAttempt, sequence}`. Data: `phase`, `connectedAt`, `disconnectedAt`, `lastLifecycleAt`, `reconnectCount`, `nextAttemptAt`, safe `closeCode`, `errorCategory`, optional hold. No history/table/migration. JSON sibling groups/friends/labels survive updates.
- Add `type:"runtime_diagnostic"` to **both** SDK runtime lifecycle schema and strict lifecycle transport payload; carries bounded diagnostic snapshot and order. It covers connecting/backoff/error/hold/latest-state updates. New worker dispatches it to diagnostics-only repository update: **no Connection FSM, quota or auth transition**.
- Connected/closed/reauthorization business events carry optional attempt/sequence+safe diagnostics metadata; worker atomically updates legacy lifecycle order + diagnostics and invokes only existing business transition once.
- New diagnostics order compares fence → epoch → socketAttempt → sequence; duplicates/lower order no-op even for same millisecond. Legacy business event without metadata uses unchanged time/state-rank fallback **only for legacy lifecycle order**. It must not overwrite newer full diagnostics in the same fence/epoch; new producer always sends complete metadata. Reader tests define legacy/complete/mixed cases explicitly.
- `sequence` increments at observation/admission before awaits, not publication completion. Fenced publisher preserves observation time/order. No monotonicity claim based solely on process clock.
- New worker handles accepted boolean after commit; only accepted state transition queues `zaloAccountStatusChanged {accountId}`. A stale/inactive/mismatched account produces no row/quota/realtime update.

## 4. Last SDK event, freshness và Redis snapshot

- `lastLifecycleAt` means last diagnostic/lifecycle transition; **`lastEventAt` means latest received SDK event**, including message/typing/status/unsupported event. Do not relabel one as the other.
- Callback updates lastEventAt in memory only. Reuse lease-renew loop to write one compact diagnostics Redis snapshot immediately on state change and at most once/30s for sampled lastEvent. No per-message DB/stream write or timer. Snapshot ≤2KiB, TTL60s (at least twice default leaseTTL30s; derive if TTL changes).
- Extend Zalo lease-store Lua/key helpers with ownership-checked snapshot write; comparison/write atomic against current lease. Snapshot includes private order for matching but never returns it to clients. Late writer after takeover cannot overwrite new snapshot. Cleanup deletes only matching owner snapshot or lets TTL expire.
- Status retains two existing targeted DB reads (account+Connection), and at most one MGET for lease+snapshot. No scans, stream reads or provider request from status. Redis unavailable => gatewayAvailable=false, freshness unknown, safe durable context retained.
- Match current lease fence + durable diagnostics epoch/attempt/lifecycle sequence before returning socketOpen=true. New lease with old connected row, expired/missing sample, mismatched order, or stale row => **socketOpen:null, freshness:unknown/stale**, never active from lease alone. No lease => socket not currently verified open. No timestamp alone proves socket health.
- `lastEventAt` may be null if no SDK event observed; quiet account does not become disconnected from age. `sampledAt` tells UI when sample was taken, not when message arrived.
- Public `runtime` optional/null for old rows/gateway. Whitelist phase, verified socketOpen, freshness, sampledAt, connect/disconnect/lifecycle/event timestamps, safe code/category, reconnect count, nextAttemptAt and boolean requiresAction. No fence, epoch, attempt, sequence, owner, auth fingerprint, QR, raw error/context/profile auth. Existing IntegrationZaloAccountPublicModel chỉ omit encryptedAuth nên không được serialize model đó trực tiếp sau khi thêm private diagnostics; list/get/status/session phải tiếp tục explicit resource whitelist và có redaction test cho nested operations/hold fingerprint. Không broad-rename business model trong phạm vi này.

## 5. Authorization refresh CAS

1. After verified UID/open, adapter serializes validated getCookie jar into auth schema; compare semantic cookie content in memory. No keepAlive polling or getContext export. Cookie unchanged => no refresh event/write.
2. `loadRuntimeAccount` returns an **internal fingerprint of stored ciphertext encryptedAuth**, not account.updatedAt or a counter only refreshed by runtime. Never log/expose fingerprint. Fingerprint changes on generic QR reconnect because ciphertext is replaced even for the same UID.
3. Runtime ownership claim phải được ghi vào highest durable diagnostics fence/epoch trong transaction **sau Redis acquire, trước load secret/provider login** qua callback main→business hiện hữu. Pool không dùng secret đã load trước claim. Nếu claim lỗi, không login. New owner chờ account row lock rồi load current auth; refresh/event từ lower durable fence bị loại, không dựa riêng publication-time Redis check. Đây là one write/ownership transition, không heartbeat DB.
4. Extend account-route encrypted `authorization_obtained` body with explicit purpose=refresh + expectedCiphertextFingerprint and attempt/order. Session ceremony body remains compatible; worker routes account refresh separately from completeTrustedDeviceAuthorization.
5. Before encrypt/write: row-lock scoped account, current Connection and workspace purge guard according to existing lock order; verify active state, immutable UID/inbox/provider, expected ciphertext fingerprint and current accepted runtime generation/attempt. Revalidate current Redis lease before commit/admission; if it cannot be established discard/hold rather than guessing owner.
6. Generic QR reconnect may race: if its ciphertext committed first, fingerprint mismatch discards old refresh. If refresh wins lock first, QR reconnect commits later and remains latest. No writes to name/avatar/sessionVerifiedAt, Connection auth status or User authorization backup unless existing owner contract requires them; this scope does not invent new user-secret handling.
7. Do not call unfenced `saveAuthorization` for background refresh. Add narrowly scoped repository method in same module and tests for same-UID QR, disconnect/paused/purge, duplicate secret event, newer lease/attempt and unchanged cookie.
8. Encrypted refresh event remains on existing secret path/AAD; expected fingerprint is inside encrypted body. Reader knows new body before producer enables it. SDK real cookie mutation is a live proof gate; if SDK does not change cookies, verified no-op is correct, not a reason to force daily login or refresh calls.

## 6. QR terminal semantics

- Generated image uses existing encrypted secret event and show_qr. Scanned clears image and shows waiting confirmation; success dialog closes only at ConnectSession completed.
- Add SDK declined adapter event and bounded terminal metadata; call SDK abort once. Worker calls existing business ConnectSession fail with `errorCode=provider_denied`, statuses=[pending], and verifies session provider/id/workspace. No new global status/error enum.
- On final SDK QR expiry before ConnectSession deadline: existing fail with `errorCode=expired`, statuses=[pending]. At actual deadline keep existing expiry rule (status expired). UI handles both expiry representations consistently. No fictitious cancelDeviceSession helper or broad expireDue sweep.
- Explicit user cancel retains existing cancel flow and stop confirmation; completed/cancelled/expired sessions cannot be overwritten by late QR failure/GotLoginInfo. Worker failure to persist is retryable, not swallowed as success.

## 7. Startup / Redis / worker recovery contract

- Existing main remains owner; no service or scheduler. HTTP server starts before account reconciliation. Consumer starts after Redis ready; readiness remains governed by Redis + consumer health, not whether every account logged in.
- Register one coalesced trigger for initial-ready, later Redis-ready/lease-loss recovery and fatal-consumer restart. One run plus at most one continuation timer/gateway. Never start a second consumer while old loop unresolved; stop/await it or leave not-ready with explicit error. Nếu consumer.start không restart-safe thì dùng local factory dựng lại đúng một instance sau loop cũ settled, giữ group/owner ID; không thêm service. Shutdown cancels trigger/timer and joins cleanup within existing30s hard deadline.
- Extend existing reconcile helper to accept afterId/deadline/signal and return proposed `{afterId, complete, scanned, restored, failed, outcomes}` with outcomes bounded to scanned page. Advance afterId after **each account attempted or skipped**, including timeout, not only after page; this prevents a slow prefix starving later accounts. Terminal failure is not counted restored.
- Proposed run: page50, max50 scanned, total wall budget30s including current attempt; provider login receives remaining deadline, no timeout×1000. Next tick resumes cursor. Tail resets cursor only at end of pass; failed transient accounts can be revisited on next pass after policy delay. No endlessly scheduled full scan beyond scan/time budget.
- Trigger coalescing/backoff uses one timer: proposed30s between continuations/recovery passes; transient runtime retry remains per-account owner, main must skip runtime already active/backoff and durable-held account. If recovery run already pending, mark a dirty flag rather than queue duplicate tasks. Cursor state bounded O(1); process restart begins at first page, later pages eventually reached via per-attempt cursor advancement.
- Initial inventory recovery may span many bounded ticks; no claim all accounts restored in30s. DB lookup rechecks current Connection/hold immediately before login, not just a stale list snapshot. Global auth request fan-out at most two starts concurrently across main/commands/passive retries using a small bounded permit in existing pool, not a new queue/process; permit không có queue Promise không giới hạn: khi bận defer qua timer retry hiện có hoặc trả kết quả chưa-dispatch phù hợp contract; local capacity không là provider auth failure. Terminal pool maps được dọn sau pending operations/handles settled; test nhiều QR sessions không tăng map vô hạn.
- Worker replay uses existing consumer ACK/reclaim and order guards; no new replay daemon. Lost realtime hint is recovered by status polling; no transactional outbox added for a cosmetic hint.

## 8. API/UI/realtime và compatibility

- Existing getStatus route and channels scope unchanged. Add status-only action/hook with same superAdmin gate for manage rows; existing full operations `{status,groups}` stays for group panel. Query keys distinct, mutation invalidators update both, no group list each status poll.
- Poll30s fallback only while settings visible; hidden tab/closed panel stops background refetch. Error retries capped/backoff; coalesce rapid realtime invalidations per matching account (proposed250ms, cleanup on unmount). Reuse one workspace socket provider, never socket per account.
- Register one IDs-only workspace realtime event at RealtimeEventType, delivery, schema, union/barrel and builder validator. Invalidation accountId được phân loại metadata không nhạy cảm trong workspace: chỉ opaque ID, không UID/tên/profile/diagnostics. Ordinary member vẫn không gọi được superAdmin status action; thêm negative test chứng minh event không cấp quyền. Guest rejected. Không mở rộng quyền đọc để phục vụ realtime, không thêm roster scan/targeting subsystem chỉ cho hint này. Authorized refetch is the only truth. Event cannot complete unrelated QR dialog or undo optimistic manual disconnect.
- Extend existing status/config dialog, no new dashboard: three distinct states, safe errors, retry/next time, timestamps and requiresAction; one optional shared dialog countdown timer, no timer/row. i18n through existing catalogs/patterns.
- Strict old transport readers reject new type/fields. **Reader-first rollout:** SDK/business/worker + realtime protocol/gateway accept new variants first, then gateway producer, then UI. Old producer → new reader must work; new producer → old reader is unsupported and prevented operationally, not waved away as optional-field compatibility.
- Rollback: stop new producers/refresh first, keep new readers to drain new entries, then downgrade readers/UI as applicable. Preserve stored JSON; old readers ignore optional JSON siblings but never consume unsupported new stream entry. No broad Redis deletion, auth reset or Connection status rewrite.

## Shared callers và file inventory additions

Read source before applying changes; proposed new names/files are not claimed existing. Phases list absolute inventory; these are mandatory additions to that list:

- Phase1/2: gateway main.ts disabled sink, runtime/ports/pool/zca-client, command-executor.ts affected result union, fenced-event-publisher.ts; tests runtime/pool/command-executor/fenced publisher; new zca-client.test.ts and reconnect-policy.test.ts (not existing baseline).
- Phase2/3: SDK Zalo account schemas/key helpers; gateway account-lease-store.ts and its Lua test double/tests; worker Zalo handler; business runtime-state/status; database account repo + JSON type; business tests and **new required** database `__tests__/integration/zalo-account-runtime-state.test.ts` for actual transactional race tests, with explicit approved disposable-DB gate in Phase3. No migration.
- Phase3: new builder `queries/use-account-status.ts`, status-only action in existing account-operations.action.ts; manage/status/connect/groups components; operations hook invalidator; en/vi catalogs; public operations/schema; realtime schemas/index.ts + builder validation. New status-query.test.tsx if existing manage tests insufficient.
- Phase4: docs/zalo-account.md, checklist only evidence-backed P0.1 ticks, generated public docs/spec per cli-mcp-docs. No changes to global skills or other integration code.

Caller map for changed internal port: zca-client production implementation; runtime listen/stopApi; runtime.test FakeApi/FakeClient; pool.test client/sink fixtures; main disabled sink; fenced publisher implementation/tests. RuntimeOrder callers: SDK schema/tests/comparator; database withRuntimeFence JSON; business runtime-state; worker lifecycle handler; service safe projection. New realtime variant consumers: protocol registry/delivery/union/index, protocol schema/stream tests, worker publish, builder validation/provider subscription and tests. Other events' behavior stays unchanged.

## TDD, resource budget và finish condition

- Characterization existing behavior expected GREEN; new failing assertion expected RED for correct reason. No production edit before that failure. GREEN minimal behavior, REFACTOR preserving assertions. Phase4 adds missing behavioral coverage without forcing unrelated existing tests to fail.
- Baseline researcher observed99 tests (gateway21/SDK31/business17/worker9/connections21); none prove new behavior. No new RED/GREEN, build, migration, live account or production deployment has happened.
- One SDK socket/listener+ping, one lease renewal, one watchdog and one retry timer/account; max2 concurrent auth starts/gateway, one recovery timer, bounded O(1) diagnostics/cursor; no event history. Stop/timeout tests inspect settlement, listener count, timer count and no future callback effects.
- Redis sampled snapshot max1/30s/account plus state changes; ≤2KiB, TTL60s default; zero per-message diagnostic network writes. Durable write only state transitions/changed credentials. API two targeted DB reads + one MGET, no group query in status path. New counters never use secret/high-cardinality raw reason labels.
- Focused tests without coverage first; final lint → touched types sequentially (include database) → affected full workspace tests/coverage with existing80threshold. No repeat full cold typecheck after same checks passed without new reason. Provider/DB integration only approved staging environment; never auto db:migrate.
- Pending proof gates: abort covers all pinned SDK request phases; physical close ack; cookie serialization/mutation semantics; staged code/QR/restart behavior; type/spec/coverage/other-channel regression. These are executable first tests/staging gates, not missing business decisions requiring an interview. If a proof fails, stop dependent implementation and revise within scope rather than claim completion.
- Plan is ready to execute TDD after review is reconciled; product readiness requires all gates pass. No implementation/commit/deploy is authorized by this document alone.

## Scope-review closure

- New test ownership: zca-client.test.ts first created Phase1, reconnect-policy.test.ts Phase2. Phase2/4 Tests Before are phase-entry tests after prerequisite files exist, not pre-plan baselines; baseline commands remain research report. Account-lease-store and command-executor tests explicitly included. Production command-executor is read-only unless behavior/types require a scoped fix.
- DB CAS/fence proof is mandatory on approved disposable DB using deterministic two-connection race assertions; fixture skip is not evidence. See Phase3 exact command, no auto migration.
- Aggregate status limit uses current settings connection list cap100. Per30s steady state≤N requests /2N targeted DB reads/N MGET, N≤100, visibility gated. Fake-clock N100 + realtime dedup/hidden-tab tests are mandatory; no new batched API/virtualization system required.
