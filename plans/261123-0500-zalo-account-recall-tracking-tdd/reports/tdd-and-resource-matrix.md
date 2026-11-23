# Ma trận TDD và giới hạn tài nguyên

Đề xuất kiểm thử cho kế hoạch, chưa chạy RED/GREEN hoặc gọi provider. Không phải bằng chứng triển khai. Root path của mọi đường dẫn tương đối bên dưới: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`.

## Ma trận hành vi

| ID | Ràng buộc | RED phải chứng minh trước khi sửa | GREEN/acceptance | Phase |
|---|---|---|---|---|
| T01 | R01/R13 | Undo parent hiện gọi generic delete, có thể kéo reply | Chỉ exact ZA tuple đổi trạng thái, reply giữ nguyên, generic regression giữ nguyên | 1 |
| T02 | R04 | Body và attachment có trước undo | Byte/text/key và số attachment không đổi; không enqueue cleanup | 1 |
| T03 | R10 | Undo hiện gọi clearTarget | Receipt/reaction còn nguyên; 90d purge vẫn chạy đúng batch | 1 |
| T04 | R08/R09 | Packet thiếu actor/provider timestamp | Provider time/actor null; received time độc lập; không suy đoán | 1 |
| T05 | R12 | Undo DM trước khi có ContactInbox | Ledger tombstone đã commit, không tạo fake contact; late original vẫn recalled | 1 |
| T06 | R02/R14 | Undo nhóm trước khi persist original | Không xóa pending payload chỉ vì undo; lưu late original vào recalled identity, không chạy automation | 1 |
| T07 | R12/R14 | Recall và message cùng chạy | Cả hai thứ tự transaction đều cho 1 identity + recalled projection | 1 |
| T08 | R01/R08 | Event trùng/sai thứ tự | Không tạo row thứ hai, không thay recallReceivedAt/actor bằng dữ liệu kém tin cậy | 1 |
| T09 | R12 | Main DB intent commit rồi shard lỗi | Pending giữ lại; recovery idempotent, lỗi shard không coi là missing | 1 |
| T10 | R12 | Shard ghi xong nhưng chưa publish/ACK | Không original leak, không notification/automation duplicate; safe replay projection | 1 |
| T11 | R12 | Tin cũ hơn 90d, không có cached pointer | Bounded primary lookup có cursor; hết budget báo unresolved, không coi là mất vĩnh viễn | 1 |
| T12 | R01/R12 | Cùng provider ID khác account/thread/workspace | Không mutate hoặc trả dữ liệu mục tiêu khác | 1–2 |
| T13 | R15 | Purge workspace/contact chạy đồng thời | Guard chặn row mới; explicit cleanup vẫn xóa; recall không enqueue purge | 1 |
| T14 | R06 | List/detail/group raw JSON có text original | Safe ZA marker không lộ text, nested body, attachment key/provider URL/signed URL | 2 |
| T15 | R06 | Realtime recall sau khi page tải và page cũ về sau | Cache marker thắng late page/event; xóa original khỏi normal chat state, channel khác giữ nguyên | 2–3 |
| T16 | R06 | Original GET sai account/conversation hoặc bị unassign | Deny trước sign/audit/provider, không leak sự tồn tại theo ID | 2 |
| T17 | R07 | Provider-URL-only hoặc object storage không còn | Trả not_archived/unavailable, không hydrate Zalo/download bytes ngầm | 2 |
| T18 | R07/R11 | Attachment request đúng ownership, object đã lưu | Signed URL ngắn hạn; audit link-issued metadata, không chứa URL/body | 2 |
| T19 | R11 | Audit queue lỗi | Hành vi best-effort được kiểm thử; không quảng cáo audit tuyệt đối | 2 |
| T20 | R03/R16 | Local hide | Không provider call, không recall timestamp, exact-one marker, review được | 2 |
| T21 | R16 | Native undo own/non-self/missing cliMsgId | DB-derived refs; non-self/missing reject trước SDK; chỉ xác nhận khi applied | 2 |
| T22 | R03/R16 | SDK deleteMessage mặc định onlyMe=false | Adapter luôn truyền true; không vô tình mở group moderation | 2 |
| T23 | R03/R16 | deleteChat concurrent new messages | Boundary bất biến từ message đã chọn; local CRM rows/files không đổi; không bulk update | 2 |
| T24 | R16 | CommandId lặp/đổi request | Same hash inspect existing outcome, khác hash conflict, không dispatch hai lần | 2 |
| T25 | R16 | SDK có thể áp dụng rồi timeout/worker chết | pending/unknown, không resend hoặc báo applied giả; giữ khả năng inspect | 2 |
| T26 | R06/R16 | Read-only token gọi POST; token chỉ có channels | Từ chối mutation/thiếu inbox scope bằng middleware thật | 2 |
| T27 | R16 | Expired owner và workspace scheduled deletion | Chỉ exact delete/hide/recall/clear được exception expiry; read-only token vẫn không mutate; giữ guard scheduled deletion | 2 |
| T28 | R05/R06/R14 | UI recalled/hidden/provider-deleted/notCaptured | Nhãn phân biệt, explicit review click, trạng thái unavailable và timestamps đúng | 3 |
| T29 | R06 | Modal đóng, đổi conversation/workspace, quyền bị thu hồi | Bỏ query/modal originals khỏi memory cache; mở lại phải authorize lại | 3 |
| T30 | R01/R03 | Generic delete các kênh khác | Characterization test pin semantics hiện có; guard ZA legacy vẫn reject | 1–3 |
| T31 | R16 | Native gate off hoặc chưa proof | API/UI không dispatch; response unavailable rõ, unit pass không bật production | 2–3 |
| T32 | R06/R16 | Generated spec/CLI/MCP | Unique operationId, inbox scope, output machine-usable, không CLI collision, destructive confirmation | 2–3 |

## Ngân sách dự kiến cần kiểm chứng khi thực thi

- Không queue, worker pool, cron process hoặc bucket mới. Dùng worker/transport/recovery scheduler hiện có và khai báo thêm nhánh ZA cụ thể.
- Ledger recall 1 row cho mỗi provider target bị recall/local-hide, không row cho mỗi lần delivery/reaction. Ledger native 1 row mỗi commandId, không sao chép original/body/file.
- Recovery dùng pending index và keyset. Điểm khởi đầu bảo thủ: tối đa 25 target/batch, 1 batch/tick, chạy tuần tự; subbudget recall tối đa 10 giây ở đầu tick, deadline chung không quá 40 giây dưới distributed lock 50 giây hiện có. Nếu dùng tick khác phải vẫn chia sẻ ngân sách thay vì nhân đôi 40 giây.
- Legacy locator tối đa 2 shard/target/lượt; cursor lưu tiến độ, primary reads, có statement/lock timeout. Không fan-out tất cả shard hoặc coi thời hạn 90d là giới hạn đúng đắn cho recall.
- Không giữ DB transaction mở trong khi gọi SDK, object HEAD/GET, audit queue hoặc network HTTP. Đối với SQL ở hai store, ghi durable intent riêng trước, transaction/lock ngắn với lock order nhất quán; crash ở mọi boundary đều phải recover được.
- Original list projection dùng dữ liệu marker trên Message, hoặc batch lookup tối đa bằng page size; không query mỗi bubble. Không per-bubble polling.
- Signed download chỉ cấp khi người dùng/agent yêu cầu rõ; tối đa 1 object existence check cho attachment được chọn, không đọc bytes vào RAM hoặc request HEAD mọi item trong timeline.
- Native provider calls được serialize bởi runtime/account hiện có; không thêm retry/sleep loop trong gateway, không dùng timeout làm căn cứ safe-retry.
- Idempotency record native applied/unknown không được TTL-xóa rồi cho cùng commandId dispatch lại. Có thể compact metadata thành hash/target/outcome; pending repair hữu hạn, tombstone giữ đến vòng đời dữ liệu được phép purge.
- Receipt/reaction giữ cửa sổ 90d hiện có, không thêm snapshot/full event history vô hạn. Nhóm thông tin này theo dõi trạng thái đã có, không hứa event sourcing.

## Gate và lệnh

RED/GREEN: chỉ chạy file đang làm, xác nhận fail vì hành vi cần sửa (không vì import/config). Dùng đúng workspace name trong package.json. Kiểm chứng khi triển khai, không chạy trong phiên lập kế hoạch này:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-message-lifecycle.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/zalo-account-state-undo-order.test.ts __tests__/sharded-message-repository.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-thread-event.test.ts __tests__/zalo-account-group-recovery.test.ts __tests__/received-message.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-thread-event.test.ts __tests__/command-executor.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/messages-public-api.test.ts __tests__/message-queries.test.ts __tests__/delete-message-action.test.ts __tests__/chat-store.test.ts
```

Final gate sau GREEN: `pnpm lint` → touched-package `check-types` tuần tự → affected suites → coverage không hạ/ngắt threshold 80% của workspace. DB integration opt-in chỉ chạy trên DB test đã chuẩn bị sau chấp thuận migration; không tự chạy `db:migrate` hoặc `db:migrate-shards`. Nếu gate không chạy được, ghi unavailable/blocked rõ thay vì báo verified.

Controlled provider proof dùng DM/group test và đúng SDK 2.1.2; phải kiểm tra status, ownership/time restrictions, onlyMe=true, backward boundary và echo event. Không dùng tài khoản production thật như một unit test.

Bổ sung sau review: T09/T10 bao gồm publishedAt chỉ sau Redis ACK bằng rejecting publisher; T25 bao gồm gateway CAS sau khi Redis TTL hết và atomic native-applied+lifecycle intent; T15 bao gồm receipt/reaction messageContentUpdated sau local-hide; T13 phân biệt repair không tái tạo anchor đã xóa với existing contact-recreation policy khi có provider original thật mới nhận.
