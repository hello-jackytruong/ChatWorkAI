---
title: Zalo Account media R2 implementation
date: 2026-11-23
summary: Implemented isolated media archival with TDD; local gates passed and staging remains disabled
---

# Zalo Account media R2 implementation

Triển khai kế hoạch `261123-0500-zalo-account-media-r2-tdd` trên nhánh `feat/zalo-account-media-r2` trong checkout riêng, giữ nguyên WIP socket/session ở checkout gốc.

Đã thêm ledger/outbox hai bảng, truyền stream có spool và giới hạn, queue global concurrency 1 trong low process, capture nhận/gửi/echo/profile/sticker, preview riêng, API có quyền, backfill/đối soát và purge có manifest. Giữ nguyên contract gửi và logic các kênh khác.

TDD và review phát hiện rồi sửa: binding slot media, flag-off legacy rendering, alias trước shard reconciliation, QR profile commit cùng intent, contact cleanup tiếp tục từ tombstone, bigint JSON precision, workspace/account lock ordering và retry budget. PUT chưa xác định kết quả giữ fence; positive HEAD có thể phục hồi đọc nhưng không tự chứng minh an toàn để DELETE.

Local lint, typecheck 10 workspace và 872 regression tests đã qua. Coverage phần mới vượt threshold 80%; không áp dụng migration, gọi provider/R2 thật, bật cờ hoặc commit/push. Báo cáo nguồn: `plans/261123-0500-zalo-account-media-r2-tdd/reports/implementation-and-verification.md`.

Còn gate disposable DB/EXPLAIN, private R2/CDN fixture, hai replica worker và release evidence trước khi bật production. AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

## Kiểm chứng cuối

Sau khi chốt realtime readiness, tổng regression là 1.128 test PASS, typecheck 11 workspace và full lint PASS. Realtime chỉ patch attachment đích, không đổi text/translation hoặc khôi phục tin đã thu hồi; URL ký lại kiểm tra owner và parent hiện tại. Coverage business mới 96.30% lines, worker 88.97%, repository/rotation 94.44%, mọi chỉ số tổng vượt 80%. Migration và các gate DB/R2/hai replica vẫn chưa chạy; tính năng mặc định tắt.
