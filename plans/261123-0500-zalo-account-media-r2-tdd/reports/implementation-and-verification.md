# Kết quả triển khai và kiểm chứng — 2026-11-23

Code đã triển khai trên `feat/zalo-account-media-r2`, trong checkout riêng `/Users/jacky/.codex/worktrees/zalo-account-media-r2/ChatWorkAI`. Checkout gốc và các thay đổi socket/session đang làm ở đó được giữ nguyên. Chưa commit, push, apply migration hoặc bật tính năng trên production.

## Kiểm chứng local

- `pnpm lint`: PASS toàn repo, gồm agent instructions, invariants, i18n và schema drift.
- Typecheck tuần tự: PASS database, business, realtime-protocol, SDK, worker-config, integration-zalo-account, filesystem, connections, zalo-account-gateway, worker và builder. Builder chạy đầy đủ cả test types, không dùng tùy chọn bỏ qua test.
- Regression: 1.128 kiểm thử PASS; 1.124 Vitest trong 100 file và 4 kiểm thử public reader R2. Mỗi lượt Vitest giới hạn `VITEST_MAX_WORKERS=1`.
- Coverage business mới: 75 kiểm thử; statements 96.40%, branches 92.15%, functions 98.23%, lines 96.30%.
- Coverage worker media mới: statements 88.82%, branches 83.33%, functions 88.37%, lines 88.97%.
- Coverage repository/rotation sau các sửa SQL cuối: statements 94.52%, branches 89%, functions 92.45%, lines 94.44%. Không tắt threshold 80%.

| Workspace | Test PASS |
|---|---:|
| Business | 326 |
| Worker | 120 |
| Gateway | 72 |
| Realtime protocol | 105 |
| SDK | 37 |
| Integration Zalo Account | 6 |
| Worker config | 4 |
| Filesystem | 54 |
| Connections | 22 |
| Database | 51 |
| Builder | 280 |
| CLI | 47 |
| R2 public reader | 4 |

## Đối chiếu phạm vi

| Mục | Kết quả code và biên kiểm chứng |
|---|---|
| M01–M04 | Capture tại seam `create-outgoing`, DM và group; lưu intent trước ACK/clear payload, bind alias trước đối chiếu shard; backfill từ dữ liệu đã lưu. Dùng seam chung thay vì sao chép code vào từng caller. |
| M05–M06 | Descriptor riêng cho video/audio/GIF/sticker/card media, giữ outbound contract; lưu nguồn/thumbnail/poster có sẵn và preview ảnh riêng bằng encoder có giới hạn. |
| M07–M08 | Capture avatar account qua QR/reconnect trong cùng transaction, friend/contact và group; đọc avatar qua batch projection. Cover chỉ đăng ký khi consumer thực sự sử dụng. Member/cover thiếu nguồn không được giả thành bytes đã lưu. |
| M09–M10 | Sticker detail tối đa 20 ID/lần, tối đa 3 biến thể; cache theo account. Bản gốc private bất biến; preview riêng, bảo vệ cả optimizer job đã xếp hàng. |
| M11–M12 | State, projection, lỗi đã redacted, attempts, last/next attempt; retry tối đa 5 lần cho cùng revision, base 30 giây + jitter, Retry-After tối đa 15 phút; empty response chỉ có một lần retry. |
| M13 | Queue riêng trong low process hiện có, global concurrency 1, backlog Redis tối đa 50, ưu tiên live/resource/backfill và promotion khi già hóa. |
| M14–M16 | SHA-256, MIME/size thực, tên, dimensions/duration kèm provenance; locator mã hóa AAD theo workspace/account, identity không phụ thuộc URL ký; namespace riêng và con trỏ shard có timestamps. |
| M17 | Sáu procedure public, scope inbox cho nội dung và channels management cho tài nguyên hồ sơ; kiểm tra owner hiện tại, Message tồn tại/chưa bị thu hồi trước ký URL 300 giây. |
| M18–M20 | HTTPS/CDN đã xác minh, DNS pin mỗi redirect, kiểm tra IP/byte/MIME; spool file 0600 + PUT known-length, deadline/abort, finally cleanup và scavenger bounded. Không tạo multipart upload. |
| M21 | Natural identity, slot, CAS lease, alias merge và reference revision; event lặp sửa intent còn thiếu. |
| M22–M23 | Backfill account/conversation/time window có cursor, tối đa 50 tài nguyên; HEAD tối đa 50, prefix LIST tối đa 100 có continuation, dry-run, outage là unknown. |
| M24 | Undo/disconnect giữ archive; contact delete giải phóng reference cùng tombstone và recovery tiếp tục phần còn lại; orphan hai lần quan sát cách nhau 24 giờ, reset grace khi reattach; workspace chờ manifest và remote outcome trước khi xóa parent. |

Các kiểm chứng trên là unit/contract/regression; không thay thế kiểm chứng DB concurrency hay S3 thật.

## Review và các sửa cuối

Review độc lập: [review-implementation.md](./review-implementation.md). Các finding đã xử lý bằng kiểm thử:

- Slot `original`/`thumbnail` từ gateway được bind đúng attachment.
- Flag mặc định tắt và chưa có ledger giữ đường xem legacy hiện có; ledger private và parent đã xóa vẫn được bảo vệ.
- Owner account/group/contact/sticker có API management, tách quyền đọc nội dung.
- QR profile và media intent nằm trong transaction kết nối, tránh đã commit nhưng replay không sửa được intent.
- Contact cleanup chỉ tiếp tục media Zalo qua tombstone hiện có; không bật generic MessageCleanup cron. SQL không tham chiếu cột `ContactInbox.workspaceId` không tồn tại; bigint trong JSON được cast text.
- Upload có HEAD xác minh được có thể phục hồi đọc theo token CAS; vẫn giữ fence khi remote outcome chưa xác định.
- Kiểm tra candidate được hoãn và xoay công bằng; deletion page bỏ qua các PUT chưa được phép xóa để không chặn tài nguyên khác.
- Reattach reset orphan grace. Completion lấy workspace fence trước account lock, cùng thứ tự registrar.
- Media lưu xong phát sự kiện realtime theo đúng attachment ID, owner/inbox/assignment hiện tại và URL ký 300 giây; không lộ object key. UI chỉ cập nhật attachment đích, giữ text/translation/attachment khác và bỏ qua tin đã thu hồi. Redis append lỗi giữ projection để retry; workspace frozen được guard.
- Proxy attachment cũ chỉ nhận token HMAC ràng buộc ref ID; resolver không mint proxy token cho Zalo. Luồng Zalo mới kiểm tra parent hiện tại trước mọi lần ký.
- Retry thủ công không reset ngân sách 5 lần. API status trả checksum, provider resource ID và timestamps phục vụ tracking; lỗi revision/source khi retry dùng lỗi validation có field, không thành lỗi hệ thống.

## Migration và gate trước khi bật

Đã generate và inspect, **chưa apply**:

1. `packages/database/drizzle/20261123082236_zalo_account_media/migration.sql`: hai bảng, enum, index và FK reference → asset có RESTRICT.
2. `packages/database/drizzle/20261123084640_zalo_account_media_lookup_indexes/migration.sql`: các index lookup/cleanup và predicate lease. Không sửa Message/Attachment DDL.

Cờ `ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED` mặc định `false`. Các gate còn chờ:

- Phê duyệt và áp dụng migration vào môi trường disposable/staging; chạy DB integration và EXPLAIN, đặc biệt claim/registration/delete race và shard lịch sử.
- Kiểm chứng R2 private bucket/public reader, CDN fixture của account thử nghiệm và hai replica worker cùng Redis chỉ có một transfer.
- Kiểm chứng QR/inbound/own-echo thật, reconnect, abort/shutdown và resource usage trước khi bật cohort.
- Ghi operational route vào `docs/zalo-account.md` khi có bằng chứng release, theo Phase 4.

Một PUT đã phát đi nhưng mất tiến trình có thể chưa xác định kết quả. HEAD 404, lease hết hạn và outage không chứng minh rằng PUT cũ không thể hoàn tất muộn. Code giữ manifest/fence và báo purge chưa hoàn tất; positive HEAD có thể phục hồi đọc nhưng không tự cho phép DELETE. Chỉ tín hiệu transport thực sự đã kết thúc hoặc bằng chứng quiescence độc lập mới được gỡ fence. Các gate live này chưa chạy và không được đánh dấu hoàn tất.

Signed URL đã phát hành có thể dùng đến hết TTL 300 giây; thu hồi Message chặn việc cấp URL mới. Rollback tắt producer mới, giữ ledger/objects và khả năng đọc; không drop bảng hoặc xóa archive để rollback.
