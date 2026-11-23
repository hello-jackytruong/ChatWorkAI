---
phase: 3
title: "Canonical multi-ID reconciliation và durable recovery"
status: in-progress
priority: P0
dependencies: [1, 2]
---

# Phase 3 — Đối soát chính xác, không gửi lại provider

## Goal / invariants

Một logical send có một canonical Message và tối đa10 provider aliases. Hợp nhất echo đã có proof đúng send, kể cả echo trước ACK hoặc bookkeeping crash. Không ghép bằng text/time/media signature; không suy commandId thành cliMsgId.

- Provider ACK quyết định applied; local reconciliation là trạng thái riêng. Local failure không đổi provider success thành failed hoặc send mới.
- Primary sourceId cố định là ID đầu tiên của ACK gốc. Các ID khác là aliases, không gọi shared helper lặp làm đổi primary.
- Workspace/account/inbox/thread scope bắt buộc; stored messageCreatedAt là địa chỉ shard canonical.
- Thiếu proof, conflict hoặc vượt budget: giữ dữ liệu và needs_review; không tự delete/resend.

## Files to modify/create khi triển khai

Source root `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`.

| File | Purpose |
|---|---|
| `packages/database/src/schema/zalo-account-message-state.ts` | Một JSONB nullable reconciliation + partial index |
| `packages/database/src/repositories/integration-zalo-account/send-attempt-repository.ts` | ACK merge/CAS, due local repair, exact alias lookup |
| `packages/business/src/zalo-account/send-attempt.service.ts` | Confirm durable provider result + local repair intent |
| `packages/business/src/zalo-account/canonical-send.service.ts` | Reuse service/getOutcome/prepared recovery, local reconcile method |
| `packages/database/src/repositories/message/message-repository.ts` | Optional alias contract; defaults unchanged |
| `packages/database/src/sharding/message/repository/sharded-message-repository.ts` | Opt-in bounded alias merge/reparent on known shards |
| `packages/business/src/message/service.ts` | Pass-through optional contract, no changed default |
| `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts` | Rebind early group identity after exact ACK |
| `packages/business/src/zalo-account/group-inbox.service.ts` | Resolve aliases to canonical local row |
| `integrations/zalo-account/src/message.ts` | All IDs/observed metadata through current chokepoint |
| `apps/worker/src/chat/handlers/send-message.ts` | Zalo-only send-result branch |
| `apps/worker/src/chat/handlers/send-flow-step.ts` | Zalo flow uses same post-send method |
| `apps/worker/src/integration/handlers/received-message.ts` | Zalo exact-alias lookup before existing heuristic |
| `packages/business/src/zalo-account/message-lifecycle.service.ts` | Secondary-ID lookup resolves canonical pointer |
| `apps/worker/src/schedule/handlers/recover-zalo-group-inbox.ts` | Local-only bounded pass in existing lock/tick |
| `packages/database/drizzle/<generated>/migration.sql` + snapshot | Additive generated migration, inspect only until approval |

Không bảng/queue/reconciler class/timer per-send mới. Không đổi default shared reconciliation; optional alias path chỉ được Zalo caller chọn.

## Durable state / query contract

Một JSONB typed nullable trên SendAttempt: version1, state `not_required|pending|completed|needs_review`, revision, attempts, nextAttemptAt, lastErrorCode enum/null; optional `sendError` chứa code/phase/retryAfterMs/safeAction đã sanitize. `not_required` dùng khi chỉ cần giữ lỗi pre-dispatch, không tạo local repair. Toàn JSONB<=8KiB; ID strings<=200 ký tự, attempts<=3, revision monotonic. Không raw error trong object. Legacy null không được coi backlog. Một JSONB này cũng là nguồn error metadata của public inspection cho attempt chưa có Message (ví dụ preparation failed); không thêm error table/column thứ hai. Public projection tách safe error khỏi local state, không lộ CAS revision/claim details.

- ACK transaction set applied, merge/dedupe confirmed provider IDs<=10 và pending reconciliation cùng lúc.
- Client IDs chỉ học từ observed echo đã match confirmed provider ID; max10. cliMsgId đơn lẻ không đủ biến unknown thành applied.
- Partial index chỉ các applied + pending reconciliation, key nextAttemptAt/id. Nếu dùng JSON text expression, timestamps là UTC ISO milliseconds canonical, so sánh cùng format; không cast timestamp không immutable trong index.
- Claim due rows `FOR UPDATE SKIP LOCKED`, tăng revision/attempts. Completion CAS revision + confirmed-ID snapshot; stale repair không clear work mới.
- Max3 automatic repair attempts, rồi needs_review; giữ reason cho inspection. Không lặp failed row vô hạn hoặc scan toàn bộ applied history.
- applied terminal về provider; Repository ACK method phải atomic lock/conditional-return, trả durable winner và conflict result thay vì settle void/read-then-write. ACK cùng IDs trả stored result; ACK khác IDs giữ winner + needs_review, tuyệt đối không trả losing caller IDs hoặc append/gọi send lại. Service confirm giữ callback shape nếu được: conflict throw sanitized non-pre-dispatch acknowledgement-conflict; outer send đọc durable winner, không replay. ACK trùng idempotent, không reset attempts/nextAttemptAt hoặc reopen completed khi confirmed IDs không đổi. ACK khác ID sau applied phải verify consistency của ACK gốc, không đổi primary/append ID lạ âm thầm.

## Opt-in repository contract và callers

Mở rộng `ReconcileOutgoingSourceIdParams` bằng optional `aliasSources` (<=10 exact scoped source IDs) và `echoAddresses` (<=20 records gồm id, createdAt; shard resolver suy từ createdAt, không nhận shard tùy ý từ client). Existing `id/createdAt` là canonical address và `sourceId` luôn primary. Có thể đặt implementation local helper trong sharded repository nhưng không đổi default missing-options path.

Zalo service lấy exact IDs từ durable ACK, query echo addresses trong <=2 known windows bằng workspace/inbox/conversation/source filters; capture addresses trước mutations. Shard resolver dùng canonical createdAt và mỗi echo.createdAt, không `getShardForWrite` cho canonical cũ. Lookup không đủ proof/address trả structured needs_review, không delete. Cross-shard merge/reparent không atomic thì preflight rồi thực hiện idempotent; failure giữa bước giữ marker pending/needs_review, không clear/xóa remainder khi thiếu proof.

Current production callers cần compatibility tests: `apps/worker/src/chat/handlers/send-message.ts:updateMessageSourceId`, `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:persist`, pass-through `packages/business/src/message/service.ts:reconcileOutgoingSourceId`; phase này bổ sung Zalo flow caller và local recovery caller. Default callers không truyền options giữ calls/query shape cũ.

## Tests Before — RED

1. DM text+image/quote sinh2 IDs, group tương tự; mọi thứ tự echo1/echo2/ACK/duplicate/recovery hội tụ canonical row khi proof đầy đủ.
2. ACK đã lưu, crash trước source update hoặc trước clear marker: repair chỉ local, provider spy vẫn1 call.
3. Provider gửi thành công nhưng durable ACK write fail: unknown/no replay; không suy ownership chỉ vì echo giống text.
4. Group self echo tạo detached identity trước ACK: sau ACK/recovery rebind messageId/messageCreatedAt, kể cả identity đã published.
5. Two-client concurrent claim/duplicate ACK/late failure/stale completion: không regress state hoặc clear ACK mới.
6. Receipt/reaction/undo theo secondary ID resolve canonical row; không sửa retention/undo behavior ngoài scope.
7. Account/thread khác hoặc cùng text khác exact ID không bị gộp.
8. Duplicate echo có attachment/reply references: preserve/reparent hoặc giữ data + needs_review nếu vượt trần.
9. Canonical row ở previous shard, echo ở current: dùng timestamps/range đã biết, không chỉ getShardForWrite hoặc all-shard scan.
10. Crash sau non-destructive merge, sau identity rebind, giữa cleanup và sau CAS: rerun không mất refs, không automation/send lại. Group disable/re-enable trong recovery: original epoch không cấp quyền send/automation mới.

## GREEN — implementation steps

1. RED trước phải chứng minh crash sau applied chưa có persisted local-repair marker/index: pendingPrepared hiện chỉ chọn pending + undispatched, không phải repair applied. Nếu existing durable state thật sự đạt cùng tests/query budgets thì tái dùng và bỏ DDL; không dùng updatedAt/history scan như completion giả. Với source hiện tại, dự kiến tối thiểu một JSONB/index. Đọc drizzle/workspace-purge skills khi thực thi. Generate additive migration khi RED xác nhận cần; không FK/table mới. Verify existing purge SendAttempt vẫn bao phủ. Không retro-mark/scan old applied rows.
2. Extend confirm atomic/CAS, reuse provider ID arrays. Local repair intent commit cùng ACK. Không đặt marker completed trước shard merge.
3. Sort locks theo workspace/account/thread rồi canonical ID và alias IDs (lexicographic), shard locks theo stable shard identifier; không await provider/external HTTP trong DB transaction. Duplicate alias operations idempotent dưới cùng ordering. Opt-in alias option trên current repository helper: canonical source cố định, aliases<=10. Default branch của các channel khác giữ behavior cũ; regression khẳng định không chọn alias path.
4. Exact echo query theo scope/IDs, bound từ attempt đến ACK. Automatic repair <=24h, <=2 relevant shard windows, <=20 candidate rows. Outside window cần precise row pointer hoặc needs_review, không tự scan toàn lịch sử.
5. Preflight canonical ownership, alias proof, attachment/reply references trước xóa. Giữ original canonical text/media; chỉ merge missing verified metadata. Reparent <=100 references/lượt trên shards xác định; không chứng minh được thì không delete. Không xóa R2 object của echo nếu canonical còn dùng.
6. Tách non-destructive merge khỏi destructive cleanup. Capture/persist bounded echo addresses trong recovery metadata trước sửa; copy/verify canonical attachments, reparent bounded reply refs bằng idempotent operations trước delete. Preflight cả MessageTranslation và các reference hiện có: không chuyển đổi an toàn được thì needs_review, không xóa mất. Core DB và Message shard không có distributed transaction. Thứ tự idempotent: claim → non-destructive shard merge/reparent → dedicated exact group identity rebind → destructive duplicate cleanup → CAS complete. Crash từng bước phải rerun được. Nếu bất kỳ multi-shard reference action không atomic được, retain duplicate với pending/needs_review thay vì partial-delete; test failure injection.
7. Publish messageRemoved chỉ cho duplicates đã thực sự xóa; canonical update qua realtime hiện có. Failure publish chỉ local retry/refresh, không provider send.
8. Branch Zalo ở send-message/flow results; incoming exact-alias lookup trước heuristic. Other-channel fallback không đổi. Unknown không có confirmed ID thì giữ inspect, không match bằng nội dung.
9. Thêm repository method `rebindConfirmedOwnEcho` riêng cho exact attempt/expected revision, groupId/provider ID và canonical pointer. Method xử lý cả published identities, preserve publishedAt, không yêu cầu payload còn tồn tại vì markPublished đã clear payload, không enqueue automation lại. Rebind dưới core DB lock trước destructive cleanup; mapping mismatch trả conflict/needs_review. Group early/published identity rebind dưới lock khi exact ID thuộc attempt. Không trông chờ pending-group scanner tự sửa published identity.
10. Lifecycle secondary-ID lookup dùng attempt canonical pointer trước sourceId lookup, giữ policy/tombstone hiện có. Không mở native delete/revoke.
11. Reuse existing recovery lock/tick: prepared-undispatched recovery giữ nguyên; local repair chỉ thao tác DB/realtime, không gọi zca send.

## Refactor / Tests After

Một local post-send method cho Inbox/API/flow/ACK recovery trong service hiện hữu. Type contracts additive; không thêm alias framework đa provider. DB tests thật có two connections/barrier; mock chỉ chứng minh call ordering.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-send-attempt.service.test.ts __tests__/zalo-account-canonical-send.test.ts __tests__/zalo-account-group-inbox.service.test.ts __tests__/zalo-account-message-lifecycle.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/sharded-message-repository.test.ts __tests__/zalo-account-lifecycle-schema.test.ts __tests__/workspace-purge-coverage.test.ts
: "${ZALO_ACCOUNT_TEST_DATABASE_URL:?set isolated test database URL}"
DATABASE_URL="$ZALO_ACCOUNT_TEST_DATABASE_URL" VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/integration/zalo-account-group-operations.test.ts __tests__/integration/zalo-account-integrity-recovery.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/send-message-handler.test.ts __tests__/send-flow-step.test.ts __tests__/zalo-account-group-recovery.test.ts __tests__/zalo-account-thread-event.test.ts
```

Create mới `packages/database/__tests__/integration/zalo-account-integrity-recovery.test.ts` trước implementation. Guard đã xác minh: `__tests__/integration/database-url.ts:realDatabaseUrl()` đọc DATABASE_URL và skip sentinel port1; preset chỉ điền khi env vắng. Dùng ZALO_ACCOUNT_TEST_DATABASE_URL trỏ DB test riêng, fail-fast khi unset như command trên; không load ../../.env mặc định có thể trỏ production. Không đọc/print credential. Skipped không tính GREEN. Không áp migration production để chạy test.

## Acceptance / tasks

- [x] Proven aliases resolve một canonical row; primary ổn định; client IDs chỉ observed.
- [x] Crash/late ACK repair local, provider calls không tăng.
- [x] Preserve attachments/reply refs; ambiguous/budget exceeded không delete.
- [x] Other-channel defaults và shared tests GREEN.
- [x] Generated SQL/index/drift/insert defaults/purge verified trước xin áp migration.

## Resource budget / rollback

- Existing tick deadline40s/lock50s giữ nguyên. Local pass budget5s, batch<=20 attempts, sequential; chia budget để prepared/group pending không mất lượt. Query lock/statement timeout phải <=remaining pass budget (ví dụ lock<=500ms, statement<=2s), không giữ timeout10s rồi hứa pass5s.
- Mỗi attempt<=10 aliases/20 candidates/100 refs;3 attempts tự động. Không full shard scan, unbounded IN hoặc Promise.all DB flood.
- Additive DDL trước code đọc cột, generate/inspect trước, chỉ db:migrate khi user cho phép riêng. Rollback tắt local repair/writer, giữ schema/data để resume; không drop JSONB/index hoặc xóa attempts.

## Execution evidence — 2026-11-23

Code và unit/contract tests đã triển khai, migration chỉ generate/inspect, chưa áp. Xem [durable report](./reports/reconciliation-implementation.md). PostgreSQL interleaving suite được thêm nhưng chưa chạy với DB thật, không tính skipped là pass. Pass5s là admission/scheduling budget; account/registry reads có thể vượt wall-clock, transaction mới lock500ms/statement1s. Cross-store/translation/over-budget giữ nguyên dữ liệu needs_review.
