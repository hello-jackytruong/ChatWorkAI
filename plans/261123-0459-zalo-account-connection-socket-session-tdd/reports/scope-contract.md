# Hợp đồng phạm vi P0 · 1

Ngày: 2026-11-23. Yêu cầu: `/ak-plan --TDD`, chỉ lập kế hoạch chi tiết cho **P0 · 1. Kết nối, socket và phiên đăng nhập** trong `docs/zalo-account-checklist.md`.

## Outcome

Zalo Account chỉ báo hoạt động khi socket thực sự mở; phân biệt chính xác Connection/gateway/socket; phục hồi lỗi tạm thời có giới hạn; bảo toàn lease/fence, authorization, QR cancellation và tính ổn định của kênh production khác. Giao diện và API có thông tin trạng thái an toàn, realtime có polling dự phòng, tài nguyên tỷ lệ theo account đang hoạt động.

## Constraints

- Lập kế hoạch, không sửa source/test/config, không chạy tài khoản thật, không áp migration, commit/push/deploy.
- HOLD SCOPE: giữ đủ 17 mục P0.1; không kéo P0.2–P0.4 hoặc P1–P3 vào kế hoạch.
- Tái dùng gateway, SDK ports, lease, event stream, worker handler, Connection transitions, API status, realtime và UI Zalo Account hiện có.
- Không tạo app/service triển khai/queue mới, không bump `zca-js`, không đổi semantics Connection chung hay kênh Zalo OA.
- Không thêm bảng/history dashboard hoặc migration chỉ để lưu trạng thái mới nhất; ưu tiên JSON operations/Redis snapshot có giới hạn đã thuộc account.
- Thay đổi shared contracts chỉ additive và Zalo-specific, liệt kê consumers/tests và rollout mixed-version; không refactor transport/realtime chung.
- Không lưu/công khai raw error/context/cookie/IMEI/userAgent/fence/owner; secret refresh dùng luồng mã hóa và CAS riêng.
- TDD theo từng behavior: characterization GREEN, behavior mới RED vì đúng lý do, thay đổi tối thiểu GREEN, REFACTOR rồi chạy lại. Việc lập kế hoạch không phải bằng chứng RED/GREEN đã chạy.
- Không ghi đè các kế hoạch đang tồn tại trong working tree, nhất là kế hoạch P0 tổng thể. Kế hoạch mới có authority riêng; khi triển khai chọn đúng một kế hoạch để tránh sửa trùng.

## Non-goals

Media R2/S3, thu hồi/tracking nội dung, message dedupe/send-attempt mới, sticker, group admin, friend/profile enrichment, history crawler, uptime analytics dài hạn, proxy UI, native send/delete operations và scheduler toàn nền tảng.

## Acceptance

1. Từng mục P0.1 có phase sở hữu, source evidence, test matrix và tiêu chí kết thúc.
2. Race stop/reconnect/late SDK result và stale callbacks được kiểm thử; không có >1 socket đang dùng, retry timer hoặc login attempt đang hoạt động hợp lệ/account.
3. Mã đóng/reason an toàn và auth/transient/identity mismatch phân loại theo bằng chứng; unknown error không tự coi là revoked.
4. Status mới không làm đổi ý nghĩa/trường legacy; không leak secret hoặc claim connected từ lease-only.
5. Realtime theo workspace, guest-excluded, nội dung tối thiểu và refetch qua quyền hiện hữu; polling chỉ khi cần.
6. Startup/Redis recovery không full-scan, không hồi sinh manual/paused/disconnected/needs-reauth, không retry storm.
7. Credential refresh không ghi đè QR/reconnect mới hoặc authorization sau disconnect; giữ identity và encryption AAD hiện hữu.
8. Ngân sách timer/Redis/DB/event/poll được định lượng và có kiểm thử fake-time/counter; không thêm heartbeat provider vô cớ.
9. Kiểm thử hồi quy kênh khác, shared Connection/realtime, public spec và Edge graph được liệt kê với lệnh thật, chạy tuần tự khi thực thi.

## Phương án và trade-off

- **Chọn:** sửa tại Zalo-specific seams và mở rộng tối thiểu typed contracts. Giả định pinned SDK phát lifecycle như source; nếu fixture thật bác bỏ, giữ trạng thái unknown và sửa adapter, không kéo generic platform vào phạm vi.
- **Không chọn:** thay Connection state machine/realtime engine chung. Có thể chuẩn hóa nhiều provider nhưng tăng blast radius đối với các kênh production, không cần cho yêu cầu này.
- **Không chọn:** chép pool/retry/scheduler ZaloCRM. Repo hiện có lease/fence và ownership phân tán mà mẫu tham khảo không thay thế được; retry chồng tầng làm tăng socket và tài nguyên.
- Hướng tốt hơn là giữ kiến trúc hiện hữu, dùng ZaloCRM làm bằng chứng cho UX/event mapping; không tìm thấy nhu cầu tạo một framework mới.

## Trạng thái

Các phase chưa triển khai. Các giá trị budget/timeout đưa vào plan là giá trị thiết kế được đề xuất để kiểm thử, không phải hạn mức chính thức của Zalo. Các thay đổi plan dựa trên source/review không tự đổi quyết định scope của người dùng.
