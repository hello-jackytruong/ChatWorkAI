# Validation và quyết định sau review

Ngày: 2026-11-23. Phạm vi kiểm tra là **tài liệu kế hoạch**, không phải implementation. Không chạy test ứng dụng, gọi provider, sinh/apply migration, commit hoặc deploy.

## Hợp đồng

- Giữ toàn bộ R01–R16 của P0 · 3; không triển khai P0 · 1/2/4 hay P1–P3.
- Ba phase tuần tự; mỗi phase có Tests Before/RED, GREEN, Refactor, Tests After, lệnh, acceptance và rollback.
- Tối đa hai bảng metadata main DB, hai service Zalo Account mới và pure projector; không copy body/blob, không queue/daemon/permission role mới, không đổi generic delete hoặc group identity/send-attempt schema.
- Xem original dựa trên ACL conversation hiện có. Saved download chỉ cho bản đã lưu; audit view/link-issued best effort; original không có TTL mới, receipt/reaction giữ cửa sổ 90 ngày.
- Native undo/deleteMessage/deleteChat đều nằm trong implementation scope; server gate mặc định tắt đến controlled live proof. Không suy đoán status/provider IDs/quyền người gửi.

## Red Team Review

Ba lens độc lập: [Failure Mode Analyst](review-failure.md), [Security Adversary](review-security.md), [Assumption Destroyer và Scope Critic](review-assumptions.md). Các báo cáo là snapshot trong lúc soạn; bảng adjudication dưới đây ghi trạng thái sau cùng, thay cho các open/partial note cũ trong snapshot.

| Finding đã gom trùng | Evidence chính | Quyết định và nơi xử lý |
|---|---|---|
| Legacy envelope và job generic đã queue vẫn có thể cascade replies | `apps/worker/src/events/zalo-account/handler.ts:219`; `apps/worker/src/integration/handlers/incoming-message-change.ts:265`; sharded repository shared source-delete | Accept, sửa protocol/inventory/test phase 1: cả envelope lẫn job cũ được early-route riêng ZA; generic non-ZA giữ nguyên |
| Crash sau shard/applied trước realtime ACK mất thông báo vĩnh viễn | `packages/business/src/platform/realtime-broadcast.ts:228,303`; best-effort helper nuốt lỗi | Accept, phase 1 dùng appliedAt/publishedAt và rejecting publisher có Redis ACK, recovery cho applied-but-unpublished; at-least-once, không hứa exactly-once |
| Redis TTL hết có thể cho destructive dispatch lại | `apps/zalo-account-gateway/src/transport/command-executor.ts:108,132` | Accept, phase 2 gateway-only durable pending→dispatched CAS; chỉ winner gọi SDK, row dispatched cùng fence cũng không cho call lại; fake-clock RED |
| Native applied và lifecycle intent không atomic gây mất projection | `apps/zalo-account-gateway/src/transport/command-executor.ts:158` | Accept, phase 2 cùng main transaction ghi applied + recall/provider-delete repair obligation; provider network ngoài transaction |
| Sidebar, quoted original ngoài trang và translation enrichment có thể bypass redaction | `features/conversations/queries/list-conversations.query.ts:180`; `features/messages/queries/index.ts:52`; `features/messages/api/public.ts:208` dưới builder src | Accept, phase 2 bao phủ compact/full/get, ALL-ZA quote target batch, final projection sau enrichment và pre-sign guard; phase 3 scrub quote nhưng giữ reply body |
| Receipt/reaction messageContentUpdated phát raw original sau local-hide | `packages/business/src/zalo-account/message-lifecycle.service.ts:188`; `group-inbox-repository.ts:193` | Accept, phase 1–2 gọi same projector/pending fence tại caller cụ thể; phase 3 monotone merge messageContentUpdated; serialized-event RED |
| Re-arm state latches cho transition thứ hai/late original còn thiếu | Recall ledger nhiều trạng thái, existing metadata update path | Accept và đã đóng: lifecycleRevision, reset appliedAt/publishedAt khi có transition mới, revision-CAS để worker cũ không ACK transition mới |
| Repair có thể bind lại anchor đã xóa hoặc dùng hết ngân sách host | `contact/service.ts:779`; `message-cleanup/service.ts:108`; existing recovery host 40s | Accept trong phạm vi: phase 1 anchorBoundAt/discardedAt, không rebind pointer cũ; unbound không tạo contact/placeholder ở anchor tái tạo sau observation. Incoming original thật vẫn theo existing recreation policy. Recall tối đa25 target/10s trong shared40s, nhường thời gian cho send/group; không làm purge engine mới |
| Inventory có path/test-action/locale count sai | File inspection, live package scripts | Accept: đúng authorize-workspace-access owner, zca-client test là Create, concrete conversation-action owner, đủ21 locale JSON; test commands dùng exec vitest |

Không chấp nhận mở rộng sang full event-sourcing, strict download-compliance ledger, global archive engine, schema identity chung hoặc sửa behavior contact-recreation của các kênh khác: không cần để đạt scope và trái constraint của người dùng. Existing source cho thấy MessageCleanup cancel-on-recreation là policy có chủ ý, không được đổi thành purge vĩnh viễn qua feature này.

## Verification Results

- Tier: Standard (3 phase), Fact Checker + Contract Verifier; bổ sung flow tracing cho các race/caller quan trọng.
- 30 source ownership/contract anchors đã kiểm tra (10/phase): **30 verified, 0 failed, 0 unverified** trong [bảng evidence](verified-anchors.md).
- Các bảng/service/helper/route/test mới là **proposed**, không giả tồn tại sẵn; Modify paths tồn tại. Locale inventory dùng brace notation đã đối chiếu cả20 sibling và en.
- `ak plan validate` đã pass format. Đã kiểm tra frontmatter, links, sequence3 phase và implementation checkboxes đều pending.
- Lệnh test/type/i18n đã kiểm tra tĩnh với workspace package scripts; chưa chạy vì chưa có code/test implementation mới. Đây không phải kết quả GREEN hoặc provider proof.
- Không có live task-management capability phù hợp; checkbox và AgentKit plan index giữ trạng thái, không tạo chat/task/automation mới.

## Validation decisions

Không hỏi thêm lựa chọn sản phẩm trong lượt này: scope, ranh giới các kênh, quyền theo conversation và nhu cầu giữ tracking đã đủ rõ. Những lỗi tìm thấy là correction có thể xác minh bằng source; đã áp dụng vào draft. Không đổi quyết định người dùng hoặc tự cắt R01–R16.

Các điều kiện còn cần khi thực thi, không phải câu hỏi chưa trả lời của kế hoạch:

- Xác nhận status/actor/time/ownership và boundary thật với pinned provider trên account test trước enable native.
- Migration additive phải được đọc SQL và chấp thuận riêng trước apply.
- File chưa từng ingest/URL đã mất không được hứa khôi phục; schema/log cũ đã xóa receipt/reaction/payload không thể tạo lại từ hư không.
- Signed URL đã phát không revoke ngay qua thay đổi UI; audit hiện có best effort, không chứng minh actual byte download.
- Text+image/quote có thể sinh nhiều provider message IDs: derive refs thật, không tự chọn phần đầu hoặc báo entire-row recalled; controlled fixtures/TDD phải chứng minh target/outcome. Không có mapping thì reject trước SDK.

## Whole-Plan Consistency Sweep

- Đã đọc lại plan.md và cả3 phase sau correction.
- Các delta đã đồng bộ: user/group, P0/branch, recallReceivedAt, lifecycleRevision, appliedAt/publishedAt/Redis ACK, discardedAt/anchor binding, legacy jobs, atomic native result+intent, durable CAS sau TTL, quote/sidebar/translation/tracking-event projection, service count, expiry owner,21 locale, shared recovery budget.
- Không còn path Modify chưa xác định, link nội bộ hỏng, template TBD, test command `test -- <path>`, extra phase hoặc source change trong lượt lập kế hoạch.
- Số contradiction chưa xử lý: **0**. Readiness: kế hoạch đủ chi tiết để giao triển khai khi người dùng yêu cầu; production enablement vẫn phụ thuộc gates riêng, không tự thực thi.
