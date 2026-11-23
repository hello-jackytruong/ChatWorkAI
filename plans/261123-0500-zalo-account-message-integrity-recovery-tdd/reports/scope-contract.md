# Phạm vi nguồn và provenance

Checklist được user chốt ở commit `c331cc2d0`, file `docs/zalo-account-checklist.md`, nhánh `feat/zalo-account-checklist`. Trong lúc lập kế hoạch, một phiên khác đổi checkout chung sang `feat/messenger-remove-email-scope`; file checklist chưa có trên nhánh đó. Không restore/cherry-pick/switch hoặc sửa change của phiên khác. Nội dung dưới đây là snapshot đúng mục 4 đã commit, không phải checklist triển khai mới.

Đọc bản gốc bằng `git show c331cc2d0:docs/zalo-account-checklist.md`. Source Zalo đã khảo sát nằm trên common base `c4ad34150`; thay đổi staged Messenger của phiên khác không thuộc kế hoạch này.

## P0 · 4. Toàn vẹn tin nhắn và khả năng phục hồi

- [x] Canonical send, command ID, send-attempt và trạng thái `pending / applied / failed / unknown`.
- [x] Chống tự gửi lại khi kết quả gửi chưa xác định.
- [ ] Mọi loại gửi mới đều đi qua cùng cơ chế canonical send.
- [ ] Đối chiếu kết quả API gửi với own-echo, bao gồm một lệnh sinh nhiều message ID.
- [ ] Giữ đủ `msgId`, `cliMsgId`, thread/account identity, timestamp và loại tin.
- [ ] Xử lý event trùng, sai thứ tự, đến muộn và echo đến trước send result.
- [ ] Không bỏ im lặng tin chưa hỗ trợ: có bubble placeholder và metadata chọn lọc.
- [ ] Có metric loại payload chưa hỗ trợ, payload lỗi và thiếu identity.
- [ ] Giữ schema/version của dữ liệu chuẩn hóa để có thể sửa và đọc lại dữ liệu cũ.
- [ ] Rate limit theo account và nhóm thao tác, có `retryAfter`/cooldown.
- [ ] Phân loại thao tác đọc có thể retry và thao tác ghi có thể đã áp dụng.
- [ ] Hiển thị rõ lỗi nhận, lỗi lưu media và lỗi gửi; có thao tác phục hồi phù hợp.
