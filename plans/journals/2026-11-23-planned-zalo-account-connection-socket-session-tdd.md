---
title: Planned Zalo Account connection socket session TDD
date: 2026-11-23
summary: "Plan riêng P0.1, bốn phase TDD, giữ phạm vi Zalo Account và tài nguyên bounded"
---

# Planned Zalo Account connection socket session TDD

## Kết quả

Lưu kế hoạch tại `plans/261123-0459-zalo-account-connection-socket-session-tdd/plan.md`: bốn phase pending, mapping đủ17 mục P0.1 và53 scenario. Chỉ tạo tài liệu kế hoạch; không triển khai source, migration, commit hay deploy.

## Quyết định

Giữ Connection FSM và các kênh khác; sửa tại Zalo-specific seams. Socket open-gate, attempt fencing/abort/close acknowledgement, durable hold3000/3003, ciphertext CAS chống QR race, bounded recovery, safe diagnostics và status-only polling. Reader-first rollout; latest JSON/Redis snapshot, không table/queue/service mới.

## Kiểm chứng và tiếp theo

Hai báo cáo nghiên cứu, ba review, source/contract/link checks và AgentKit format validation. Researcher đã chạy99 baseline tests hiện hữu; chưa có test behavior mới hoặc provider live proof. Chỉ bắt đầu TDD khi người dùng yêu cầu; DB/live gates cần môi trường được phép dùng. Giữ nguyên các thay đổi của task khác trong checkout chung.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
