---
title: "Phase 1: Lifecycle, exact mutation và recovery hữu hạn"
status: todo
priority: P0
effort: "3–5 ngày"
---

# Phase 1: Lifecycle, exact mutation và recovery hữu hạn

## Context và outcome

Đọc [scope R01–R16](reports/scope-and-decisions.md), [persistence evidence](reports/persistence-research.md), [API/UI evidence](reports/api-ui-research.md), README, `docs/zalo-account.md`, `docs/zalo-account-checklist.md` và invariants 9/15/20/22/24. Trước code đọc skills business-data-access, drizzle-database, reliability-concurrency, worker-development, workspace-purge và testing-workflow. Phase này sở hữu R01–R04, R08–R10, R12–R15; cung cấp metadata và canonical pointer cho phase 2–3. Không đổi shared delete, không làm schema identity chung. Enum threadType dùng existing `user/group`, không tạo enum direct mới. Không Message-shard migration; chỉ JSON overlay hiện có. [Resource matrix](reports/tdd-and-resource-matrix.md) là ngân sách cap chung.

## Kiến trúc và schema đề xuất

**Existing:** `zaloAccountMessageLifecycleService`, `zaloAccountGroupInboxService`, message-state/group-inbox repositories, `ZaloAccountMessageIdentity` group outbox và `ZaloAccountSendAttempt` dành cho chat-send. Giữ nguyên schema hai bảng existing này. **Proposed:** `zaloAccountMessageRecallRepository`, `zaloAccountMessageRecallService` và exact repository method `applyZaloAccountLifecycleExact`; tên mới chỉ là design, chưa tồn tại. Export qua existing `integration-zalo-account/index.ts`, `zalo-account/index.ts`, root barrel tương ứng; không import `db` từ apps/integrations.

Bảng main DB thứ nhất **`ZaloAccountMessageRecall`**, không body/raw packet/provider URL. Sử dụng sharedColumns, bigint-as-string, timestamptz và pgEnum theo convention:

| Cột | Kiểu / invariant |
|---|---|
| id, createdAt, updatedAt | sharedColumns |
| workspaceId, accountId, inboxId | bigint NOT NULL; FK đúng owner hiện có, cascade; mỗi FK có leading index |
| threadType, threadId, providerMessageId | enum `user/group`, text NOT NULL; global provider ID, không fallback cliMsgId |
| groupId | bigint nullable FK local group; chỉ group, admission kiểm policy epoch hiện có; partial leading index |
| conversationId, contactInboxId | bigint nullable FK, indexed; chưa có anchor thì null; binding phải match workspace/account/inbox/thread |
| messageId, messageCreatedAt | bigint/timestamptz nullable, **cùng null hoặc cùng có**, pointer shard không FK; bind một lần; shard tuple không đổi khi late original |
| providerRecalledAt, recallReceivedAt, receivedAt, providerActorId | nullable timestamptz, nullable timestamptz, NOT NULL timestamptz, nullable text; recallReceivedAt non-null là recall intent, phân biệt row local-hide-only; thời gian provider khác observation; actor chưa chứng minh để null |
| localHiddenAt, providerDeletedForMeAt | nullable timestamptz, độc lập recall; không giả actor/time thu hồi khi local-hide/delete-only-me |
| lifecycleRevision | integer NOT NULL; tăng dưới target lock khi có state mới, duplicate không tăng |
| anchorBoundAt, discardedAt | nullable timestamptz; ghi anchorBoundAt một lần khi bind; anchor bị xóa thì discardedAt kết thúc repair, không bind sang ContactInbox mới |
| originalObservedAt, appliedAt, publishedAt | nullable timestamptz; placeholder không được coi là đã có original; appliedAt chỉ sau exact projection thành công |
| nextAttemptAt, retryCount, scanCursor | timestamptz NOT NULL, integer NOT NULL, nullable bounded JSON `{shardId, rangeStart, rangeEnd, afterId, afterCreatedAt}`; không content |
| lastErrorCode | nullable sanitized text; không raw SDK error/body |

Unique `(workspaceId,accountId,threadType,threadId,providerMessageId)`. Index pending `(nextAttemptAt,id) WHERE discardedAt IS NULL AND (appliedAt IS NULL OR publishedAt IS NULL)`; workspace leading purge index; `(workspaceId,conversationId,messageId,messageCreatedAt)` phục vụ batch projection; partial indexes mọi nullable FK. Enum/check constraints: pair pointer atomic; user/groupId consistency; không dùng DB default giả — inspect SQL và insert explicit các cột bắt buộc. Giữ tombstone tới explicit purge; không reuse receipt TTL. Bảng thứ hai native attempt thuộc phase 2; **không thêm bảng thứ ba**.

Marker canonical đề xuất trong `Message.contentAttributes.zaloAccount.lifecycle`: `{version:1, lifecycleRevision, recallId, recalled:boolean, placeholder:boolean, originalObserved:boolean, localHiddenAt:null|ISO, providerDeletedForMeAt:null|ISO}`. Merge JSON atomically vào nhánh đó, không replace stale contentAttributes; body/attachments/quote/raw group payload giữ trong DB. Timestamp/actor authoritative trong ledger; ordinary response chỉ safe projection. Đây không phải bản copy original. Set `deletedAt` cho recalled/localHidden exact target như existing sentinel để AI/context/history readers hiện lọc deletedAt tiếp tục bỏ qua tin; không xóa original. Lifecycle metadata mới phân biệt semantics, không dùng deletedAt làm nguồn truth duy nhất. ProviderDeletedForMe không tự set recall/local-hide sentinel. Reply deletedAt không thay đổi.

## Protocol scoped, transaction và idempotency

1. Chuẩn hóa undo từ normalized, fallback và **legacy `direct_undo` envelope** và cả job `IntegrationJobAction.deleteIncomingMessage` của Zalo Account đã nằm trong BullMQ trước deploy: reroute envelope tại `apps/worker/src/events/zalo-account/handler.ts`; thêm early branch `integrationType === "zaloAccount"` ở `apps/worker/src/integration/handlers/incoming-message-change.ts::deleteIncomingMessage` để validate/decode scoped source ID và route rồi gọi cùng recall service, return trước generic delete. Không suy ra actor/provider time từ job cũ nếu thiếu; channel khác đi nguyên nhánh cũ.  validate workspace/account/inbox/channel, thread/global ID; actor/time chỉ giữ khi fixture chứng minh meaning; fallback không lấy cliMsgId làm global ID. Group phải qua policy epoch admission. **Persist tombstone trước khi tìm direct ContactInbox/conversation**; unknown direct không tạo fake Contact/customer.
2. Mỗi target dùng cùng advisory key full `(workspace,account,threadType,threadId,providerMessageId)` cho recall, direct canonical persistence/own echo, group recovery và receipt/reaction phối hợp. Giữ workspace purge guard đúng thứ tự lock hiện có. Transaction main ngắn T1 upsert durable intent, tăng lifecycleRevision và reset appliedAt/publishedAt chỉ khi nhận transition mới; worker CAS hoàn tất theo đúng revision hiện tại; giữ earliest receivedAt, không làm actor/provider timestamp drift khi duplicate; commit trước shard work. Không network/storage/provider call trong transaction.
3. Nếu anchor đã tồn tại, resolve pointer theo thứ tự ledger → applied SendAttempt/group identity đã validate → bounded primary locator. Locator buộc workspace+conversation+ContactInbox+account/thread/provider ID, shard cursor tăng tuần tự; tối đa 2 shard ranges/50 candidates và 2 giây mỗi target/tick. Không dùng all-time fallback/replica/catch-null. Budget hết là pending, lỗi shard throw/retryable; không kết luận missing. Scan qua mọi range lịch sử hợp lệ bằng cursor nhiều tick, không 90-day cutoff. Scan hoàn tất mới có thể kết luận unseen và tạo placeholder.
4. Nếu **existing anchor nhưng original chưa từng thấy**, allocate canonical `messageId+createdAt` một lần trong ledger dưới target lock, rồi insert Message placeholder rỗng, marker recalled và không attachments/notification/automation. Dùng receivedAt làm timeline ordering cho placeholder, không giả đó là provider-sent time; ledger lưu providerRecalledAt riêng. Group cần group-inbox binding/epoch và existing stable identity: reuse pointer của identity hoặc reserve cùng tuple dưới lock, không tạo identity cạnh tranh. Không anchor thì chỉ ledger, không timeline giả; khi anchor hợp lệ xuất hiện, bind và tạo placeholder qua cùng protocol.
5. T2 main tx lấy lại target lock, recheck admission/binding/purge, reserve pointer nếu chưa có; commit pointer trước shard insertion. T3 lấy lại lock, ghi shard exact tuple bằng primary/write shard với mọi guards, rồi đánh appliedAt trong main. Shard write không nằm trong distributed atomic transaction: crash trước/sau shard write để intent pending; repeat exact mutation/upsert trả cùng kết quả. Nếu main commit fail sau shard success, retry giữ tuple; tuyệt đối không success trên partial shard failure. Không giữ tx qua locator/network; cap lock/statement timeout và tick deadline.
6. Direct/group original tới muộn: đi cùng lock, dùng **cùng tuple** placeholder, fill actual text/attachment một lần idempotent, đặt originalObservedAt; marker recalled không được gỡ. Group undo không set discardedAt/erase pending payload chỉ vì recall; publish original theo retained/recalled outcome, sau canonical persist mới xóa replay payload theo existing recovery contract. Không gọi onMessage, trigger, notification, unread increment cho late recalled original. Existing legacy erased payload chỉ recover khi provider gửi lại; không bịa dữ liệu. Own-echo được reconcile phải giữ provider msgId/cliMsgId/sender/thread có thật vào metadata canonical đúng target, kể cả echo không tạo Message mới; không synthesize cliMsgId hoặc làm thay đổi unread/MAC. Native chỉ enabled cho target có refs đã xác minh.
7. Existing original recall: exact update đúng tuple, không clear text/attachments, không cascade parent/replies, không gọi `deleteBySourceId` hoặc `clearMessageTrackingDetail`. Receipt/reaction tiếp tục latest-state/timestamp-order logic, giữ 90 ngày; late tracking không hồi sinh tin. Cụ thể nhánh receipt/reaction `message-lifecycle.service.ts::handle` hiện spread raw `message.contentAttributes` khi phát messageContentUpdated: bắt buộc qua same ZA projector + pending-ledger fence, kể cả localHidden-only. Client handler/store cho messageContentUpdated cũng merge monotone và không nhận raw payload trở lại; RED assert serialized event không chứa original sentinel/provider URL sau hide→receipt/reaction. Atomic marker update + ledger pending fence để projection ở phase 2 che cả khoảng crash.
8. Gắn recovery vào existing `recover-zalo-group-inbox` schedule/worker host, không queue/daemon mới: indexed due scan `FOR UPDATE SKIP LOCKED`, batch tối đa 25 intents, deadline recall 10 giây/tick nằm trong **shared recovery deadline 40 giây dưới lock 50 giây hiện có**; không cộng thêm ngân sách group recovery. Chạy tối đa subbudget recall này đầu tick rồi nhường deadline còn lại cho prepared sends/group recovery, không để vòng prepared-send dùng hết 40 giây trước khi recall có lượt; không thay retry/ordering business của các send/group. Đo thời gian mỗi nhánh trong fake-clock RED và pilot để tránh starvation, target locator cap nêu trên, cursor commit từng batch, retry backoff capped. Unknown anchor không hot-loop; nextAttemptAt tăng bounded và ingress reconcile khi anchor xuất hiện. Giữ distributed lock TTL/cadence đang có, blocked owner bare return, workspace purge freeze. Realtime dùng existing messageUpdated-compatible shape, sau commit chỉ safe marker/tuple; không payload original; idempotent duplicates không phát business side effect lần hai. `publishedAt` chỉ sau rejecting direct `publishWorkspaceRealtimeEvent(workspaceId, event)` ACK (existing platform/realtime-broadcast.ts), không dùng `queueWorkspaceRealtimeEvent` vốn catches Redis failure/coalesces và resolve; recovery quét cả applied-but-unpublished. Crash sau publish trước main ACK có thể redeliver event idempotent theo recallId+tuple/lifecycleRevision, không giả exactly-once realtime.
9. Register hai bảng mới vào workspace purge bounded drain child-before-parent. Account/inbox/group/contact/conversation explicit purge phải giữ ngữ nghĩa xóa hiện có và không để repair tái tạo original đã bị xóa. Nullable conversation/contactInbox FK dùng SET NULL có leading partial index; anchorBoundAt giữ bằng chứng đã bind, nên khi anchor/pointer cũ mất thì đánh discardedAt, không reserve pointer/bind anchor khác. Unbound intent không tự tạo contact; recovery chỉ bind placeholder vào anchor đã tồn tại tại first observed recall, không gắn placeholder vào anchor được tái tạo sau đó. Original thật tới qua ingress vẫn theo existing contact-recreation policy; không sửa cancelByInboxSource hoặc kích hoạt MessageCleanup processPending vốn chưa được schedule. Không hứa biến contact-delete thành purge vĩnh viễn khác behavior hiện có; workspace/account purge vẫn drain ledger. Thêm discardedAt IS NULL vào pending index. Đây là kiểm tra vòng đời của intent, không thêm thread-fence table hoặc background purge engine. Không recall-triggered file delete hoặc TTL; purge wins. Không backfill toàn bộ Message; sửa on-demand target có evidence.

## File inventory (absolute paths)

Tất cả đường dẫn dưới đây là implementation dự kiến; không sửa trong lượt plan. Không xóa file.

| Action | File | Trách nhiệm |
|---|---|---|
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/schema/zalo-account-message-recall.ts` | Ledger/check/index |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/partials/zalo-account-recall.ts` | Zod/pg enum contract |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/message-recall-repository.ts` | Intent, pointer, cursor, target lock |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/message-recall.service.ts` | ZA-only lifecycle protocol |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/schema/index.ts` | Export schema |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/partials/index.ts` | Export enum |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/types.ts` | Model type |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/relations/integration-zalo-account.ts` | Scoped relations |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/relations/index.ts` | Verify import AND spread |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/index.ts` | Repository export |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/message/message-repository.ts` | Interface exact mutation/scoped locator signatures |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/sharding/message/repository/sharded-message-repository.ts` | New guarded exact primary mutation/locator; shared methods unchanged |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/message-state-repository.ts` | Keep tracking; use same target lock |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts` | Retained late originals, stable pointer |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/workspace-purge/tables.ts` | Bounded drains |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/message-lifecycle.service.ts` | Route undo into new protocol |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/group-inbox.service.ts` | Recalled outcome skips live side effects |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/canonical-send.service.ts` | Bind own-message pointer without changing sendattempt schema |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/index.ts` | Export proposed service |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/integration/handlers/received-message.ts` | ZA-only ingress seam before broadcast/automation |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/events/zalo-account/handler.ts` | Reroute legacy direct_undo envelopes |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/integration/handlers/incoming-message-change.ts` | Consume already-enqueued ZA deleteIncomingMessage safely; nonZA branch unchanged |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/integration/handlers/zalo-account-thread-event.ts` | Provenance, pending outcome |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/schedule/handlers/recover-zalo-group-inbox.ts` | Host bounded recall repair |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/provider-thread-event.ts` | Actor/time normalization |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zca-client.ts` | Fallback provenance/global identity |
| Generate + inspect | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/drizzle/<generated>_add_zalo_account_message_recall/` | Additive SQL/snapshot only; exact timestamp CLI-generated |

## Tests Before / RED

Viết test trước, chạy từng nhóm có cap worker; ghi assertion đỏ do behavior còn thiếu, không do import/syntax broken. Với new module có thể viết through existing lifecycle entrypoint trước, rồi thêm repository tests khi public contract rõ. Các test characterization existing phải xanh trước khi sửa; không đổi expectation generic delete để hợp thức hóa hồi quy.

| Test path (absolute) | Create/modify | Behavior cần chứng minh |
|---|---|---|
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/sharded-message-repository.test.ts` | Modify | Pin generic source delete vẫn cascade replies; exact ZA không cascade; tuple/source/account/workspace guards, primary errors throw |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-message-lifecycle.service.test.ts` | Modify | R01/R03/R04/R08/R09/R10: no shared delete/tracking clear; timestamps/actor unknown; duplicate |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/zalo-account-state-undo-order.test.ts` | Modify | Recall/ingress/receipt/reaction serialization, no resurrection |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/zalo-account-message-recall-repository.test.ts` | Create | Scoped natural key, stable pointer, primary cursor budgets, pending/unavailable khác missing |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/zalo-account-lifecycle-schema.test.ts` | Modify | Nullable pair/FK/index/unique/no content columns |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-group-inbox.service.test.ts` | Modify | R02/R14: undo→late original giữ body, không onMessage |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/received-message.test.ts` | Modify | R12–R15: unknown DM anchor→anchor→placeholder→same-tuple original; other channels unchanged |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-recall-recovery.test.ts` | Create | Crash before/after shard/main commits, old target >90d, cursor exhaustion, batch/deadline, blocked/purge no resurrection |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-thread-event.test.ts` | Modify | Normalized/fallback/direct_undo envelope provenance, no shared delete |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/incoming-message-change.test.ts` | Modify | Already-queued ZA deleteIncomingMessage early branch; other channels keep generic semantics |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/integration/zalo-account-recall.test.ts` | Create, opt-in | Real main/shard two-worker races and repair under transaction failures; max pool 2, bounded timeouts |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/workspace-purge-coverage.test.ts` | Modify only if fixtures need | New ledgers covered, indexed FKs |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/purge-fk-indexes.test.ts` | Modify | Migration indexes and bounded drains |

## GREEN và Refactor

- [x] Implement ledger/repository+exact mutation, rồi direct/group ingress và bounded recovery theo protocol; minimal helper local, không general identity rewrite.
- [x] Chạy RED đầu tiên, sửa đúng cause; repeated event khác provider time/actor không overwrite dữ kiện đã xác thực.
- [x] Sau GREEN, gom key/guard/pointer helpers chỉ trong ZA; giữ existing shared APIs và 90-day purger unchanged.
- [x] Sinh migration bằng `pnpm --filter @chatbotx.io/database make:migration add_zalo_account_message_recall`; đọc SQL/snapshot, FK index/purge plan, không `db:migrate`/`db:setup` tự động.

## Tests After và commands hữu hạn

Từ root, **mỗi command chạy tuần tự**. RED/GREEN là focused cycle trước delivery gate; gate cuối vẫn lint → types → test → coverage. Không dùng `test -- <path>` vì có thể bỏ filter; dùng `exec vitest`. Test mới là proposal, chưa chạy ở lượt plan.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/sharded-message-repository.test.ts __tests__/zalo-account-message-recall-repository.test.ts __tests__/zalo-account-state-undo-order.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-message-lifecycle.service.test.ts __tests__/zalo-account-group-inbox.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/received-message.test.ts __tests__/zalo-account-recall-recovery.test.ts __tests__/zalo-account-thread-event.test.ts
pnpm lint
pnpm --filter @chatbotx.io/database check-types
pnpm --filter @chatbotx.io/business check-types
pnpm --filter worker check-types
pnpm --filter zalo-account-gateway check-types
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run
```

Sau các suite, chạy từng touched workspace `exec vitest run --coverage`, worker cap 1, threshold **80% unchanged**, không `VITEST_SKIP_COVERAGE_THRESHOLDS`. DB integration chỉ opt-in sau approved migration trên disposable DB: `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database test:db __tests__/integration/zalo-account-recall.test.ts`; xác nhận script chọn đúng một file bằng list trước nếu cần. Không đọc/print env secrets. Tập fixture 2 connections để test race thật, không thay bằng mock sequential rồi tuyên bố cross-store verified.

## Acceptance, risk và handoff

- [ ] Tất cả race/crash permutations có expected pending/applied rõ; exact mutation thất bại không success; no original erasure, reply untouched.
- [ ] Unknown anchor có tombstone bền vững; known anchor có placeholder thật và late original cùng tuple; timestamps không bịa.
- [ ] Query plan dùng pending/full-target/workspace indexes; representative purge EXPLAIN trong BEGIN/ROLLBACK trên disposable DB, không unbounded scan.
- [ ] Explicit purge/account teardown dừng recovery và không hồi sinh; no new TTL/queue/daemon.

Rủi ro chính là cửa sổ main/shard không atomic và legacy DM không pointer. Durable intent + exact tuple + primary cursor xử lý; phase 2 projection đọc batch ledger để fail closed khi pending. Không rollback về release ghi xóa original; deploy additive schema trước service, giữ reader compatible. Phase 2 bắt đầu sau tests lifecycle GREEN và migration SQL được review; live apply vẫn chờ approval riêng.

## Bổ sung regression vòng đời intent

RED: reserve pointer → xóa contact/conversation → recovery không tạo lại placeholder/Message; unbound recall → xóa/tạo lại anchor trước khi worker chạy → không tự bind placeholder vào anchor mới; incoming original thật sau đó theo existing recreation policy chứ không đổi ngữ nghĩa cancelByInboxSource của các kênh. Kiểm riêng trường hợp đã có Message nhưng original bytes chưa ingest để không gọi lưu object giả. Test queued legacy deleteIncomingMessage qua đúng worker handler, không chỉ direct_undo envelope.
