# Phạm vi và quyết định cho P0 · 3

Ngày: 2026-11-23. Lập kế hoạch `--TDD` (`--tdd`), HOLD SCOPE, nghiên cứu hard. Chưa triển khai, chưa chạy migration hoặc thao tác provider thật.

## Outcome

Thu hồi trên Zalo Account cập nhật trạng thái đúng tin, vẫn giữ nội dung/file đã lưu để người có quyền xem lại; phân biệt local-hide, native delete-only-me và native recall. Tracking bền vững qua event trùng/sai thứ tự, restart và lỗi giữa database chính với message shard. Kênh production khác giữ nguyên semantics.

## Constraints

- Chỉ mục 3 trong `docs/zalo-account-checklist.md`; không mở rộng socket, profile, sticker, history crawler hoặc toàn bộ media pipeline.
- Giữ shared `deleteBySourceId`, shared Conversation/Message delete semantics và trạng thái Connection chung. Chỉ thêm helper exact-message có chặn channel `zaloAccount` và nhánh projection có điều kiện.
- Tái dùng gateway/Redis/BullMQ/realtime/storage/audit, không app/queue/service daemon mới; không framework archive/retention chung.
- File xem lại là bản đã tồn tại trên storage. P0 · 2 là khả năng liên quan chưa triển khai; không hứa khôi phục bytes chưa tải hoặc URL đã hết hạn. API trả trạng thái `not_archived/unavailable`, không fetch provider khi mở mỗi bubble.
- Mọi write mới giữ workspace purge guard, indexed FK, bounded recovery. Không tạo bản sao text/blob chỉ để archive nếu Message/Attachment hiện có đã lưu.
- Không đổi `ZaloAccountSendAttempt` thành ledger đa mục đích; recovery của nó hiện dành cho gửi chat. Native operations cần outcome riêng nếu không tái dùng được cơ chế hiện có mà vẫn giữ nguyên ngữ nghĩa.
- Giữ cửa sổ 90 ngày receipt/reaction hiện tại; không xóa ngay vì undo, không bổ sung event-sourcing lịch sử vô hạn. Original được giữ đến quy trình xóa/retention được phép; không TTL mới chỉ vì recall.
- Chỉ plan/report/journal được phép ghi ở lượt này. Không sửa checklist thành done; không thay đổi các kế hoạch có sẵn.

## Non-goals

Không thay đổi kênh Zalo OA/Messenger/WhatsApp/Instagram/Telegram hoặc generic delete; không mở API sửa tin Zalo; không bulk migration/backfill toàn bộ Message; không tạo permission bit/roles mới; không nhóm moderation delete-for-everyone; không full media ingestion; không cam kết audit actual bytes downloaded qua signed URL.

## Phương án so sánh

1. Mở rộng generic delete/Message archive cho tất cả channel: ít nhánh code nhưng ảnh hưởng shared behavior đã production, không đạt constraint. Hỏng sớm khi cùng logic được kênh khác gọi.
2. Mở rộng group-only identity/outbox thành identity chung cho DM và native commands: tái dùng bảng nhưng đổi unique key/nullability và recovery engine có sẵn. Hỏng sớm nếu recovery hiểu command destructive như send.
3. Khuyến nghị: metadata ledger nhỏ riêng Zalo Account, exact-message mutation và projection riêng channel; tận dụng Message/Attachment làm original, existing audit/realtime/worker làm execution. Phụ thuộc vào message identity/pointer chính xác và recovery được index; nếu không bảo đảm phải dừng trước rollout, không full scan vô hạn để che lỗi.

Better approaches: none — hướng riêng Zalo Account theo yêu cầu là phù hợp; source cho thấy shared delete lan sang reply nên không nên sửa ngữ nghĩa shared.

## Chốt ngữ nghĩa cho kế hoạch

- Native `undo`: thu hồi tin do chính tài khoản gửi, cần `msgId` + `cliMsgId`, kiểm chứng provider trước khi bật.
- Native `deleteMessage`: luôn truyền `onlyMe=true` cho thao tác xóa phía mình. Không dựa default SDK (false).
- Native `deleteChat`: SDK xóa phía mình đến boundary cụ thể. Giữ mọi bản ghi nội bộ, chỉ lưu operation outcome/boundary, không update từng Message trong thread.
- Local hide: chỉ ẩn đúng tin trong ChatbotX, vẫn cho xem lại theo ACL; không gọi provider.
- Read original: quyền đọc conversation hiện có, kiểm tra ở server; không thêm quyền mới hoặc dùng account/channel visibility làm authorization.
- Ordinary DTO/realtime chỉ redaction với message Zalo Account có retention marker. Không thay shape/hành vi các channel khác. Không đưa original vào modal từ list/cache đã tải trước; fetch có ACL lúc mở.
- Audit view/link issuance bằng hạ tầng sẵn có, metadata ID/action/result, không log body, provider URL có credential, signed download URL. Không tuyên bố best-effort audit là chứng cứ download tuyệt đối.
- Provider actor/time thiếu phải để null/unknown; tách provider time và observation time.
- Native commands mặc định tắt ở server cho đến có bằng chứng staging cho đúng pinned SDK. Vẫn lập kế hoạch triển khai đủ 3 operation, không dùng gate để bỏ scope.

## Traceability toàn bộ mục 3

| Mục | Kết quả phải có | Phase |
|---|---|---|
| R01 | Giữ nhận undo, thay shared-delete bằng exact target cho ZA | 1 |
| R02 | Giữ group tombstone, bổ sung late-original retention | 1 |
| R03 | Phân biệt recall/provider-delete/local-hide | 1–3 |
| R04 | Không xóa body/attachment đã lưu | 1 |
| R05 | Bubble “Đã thu hồi trên Zalo” | 3 |
| R06 | Xem original với ACL hiện có | 2–3 |
| R07 | Xem/download bản file đã lưu, báo unavailable trung thực | 2–3 |
| R08 | Provider time và received time riêng | 1 |
| R09 | Actor nullable, không suy đoán | 1 |
| R10 | Không clear receipt/reaction khi undo, giữ retention 90d | 1 |
| R11 | Audit view/link intent qua hệ thống hiện có | 2 |
| R12 | DM tombstone trước message + recovery bền vững | 1 |
| R13 | Reply không bị mark cùng parent | 1 |
| R14 | Placeholder nếu chỉ có recall, original tới muộn không hồi sinh | 1–3 |
| R15 | Recall không kích hoạt purge/TTL original mới | 1–3 |
| R16 | Native undo/deleteMessage/deleteChat đủ API, execution, proof gate | 2–3 |

## Acceptance

- Mỗi R01–R16 có test viết trước và gate rõ ràng; không thay production source trong lúc lập kế hoạch.
- Existing channel delete/reply behavior được characterization test pin lại, không sửa kỳ vọng để hợp thức hóa đổi semantics.
- Không bytes download mới trên mỗi lần mở list/bubble; batch lookup metadata, exact target mutation, recovery có deadline/batch cap.
- Native pending/unknown không tự resend; lỗi/timeout không báo applied. Retry/restart không gọi destructive SDK lần hai.
- Đọc archive sau bị unassign/đổi workspace bị chặn; non-ZA DTO regression giữ nguyên.
- Migration additive, sinh và inspect trước; tuyệt đối không tự chạy migrate. Rollout/rollback đồng bộ marker, UI và projection, không rollback về phiên bản vô tình lộ original.
