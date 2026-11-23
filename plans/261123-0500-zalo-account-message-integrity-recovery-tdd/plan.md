---
title: "Zalo Account P0.4 — toàn vẹn tin nhắn và phục hồi có giới hạn"
description: "Kế hoạch TDD cho identity, own-echo, placeholder, reconciliation, admission và lỗi riêng Zalo Account."
status: in-progress
priority: P0
effort: "4 phần tuần tự; ước lượng lại sau RED tests, không cam kết lịch"
branch: feat/zalo-account-message-integrity
source_commit: c4ad34150
checklist_commit: c331cc2d0
tags: [zalo-account, tdd, reliability, backend, database, frontend]
blockedBy: []
blocks: []
created: 2026-11-23
---

# Zalo Account P0.4 — kế hoạch TDD

## Overview

Hoàn thiện đúng [P0 · 4 của checklist đã commit](./reports/scope-contract.md): giữ identity chính xác, đối soát nhiều provider ID về một tin gửi, không mất dấu tin chưa hỗ trợ, retry có phân loại và phục hồi lỗi mà không gửi trùng. Đã triển khai code theo yêu cầu `/ak-cook`; xem [báo cáo thực thi](./reports/implementation.md). Migration chưa áp, chưa gọi account thật. Các release gate DB/live/coverage còn mở. `--TDD` được hiểu là `--tdd`: RED → GREEN → REFACTOR trong từng phase.

## Hợp đồng phạm vi

- **Outcome:** tin nhận/gửi có identity/metadata đủ truy vết; provider success không bị gửi lại vì lỗi bookkeeping; Inbox/API phân biệt pending, unknown, failed và lỗi đối soát.
- **Constraints:** chỉ `zaloAccount`; giữ default shared send/receive/reconciliation cho mọi kênh production khác. Tái dùng attempt, group identity, queue/scheduler, Message, realtime, Error Log và pino hiện có. Không app, queue/pool, framework hoặc metrics server mới.
- **Non-goals:** socket/session P0.1, mirror R2/S3 P0.2, retained undo/native delete P0.3, sticker/video/history/group admin P1. Hiển thị lỗi media hiện có, không triển khai archive. Không đổi shared timeline/shard `createdAt`.
- **Acceptance:** đủ 12 mục trong [TDD matrix](./reports/tdd-matrix.md); race/crash tests có DB thật opt-in; public/UI cùng service; regression kênh khác đạt; retry/batch/log/DB có trần và rollback rõ.

## Hiện trạng và quyết định

- Đã có durable attempt và no-replay unknown; giữ `pending/applied/failed/unknown`.
- Shared `reconcileOutgoingSourceId` đã xử lý single-ID echo-before-result. Worker lấy ID đầu tiên; bổ sung **opt-in Zalo** cho tối đa 10 aliases, primary ID cố định, sorted locks và non-destructive merge/rebind trước cleanup; không đổi default kênh khác.
- Đã có `providerMessageIds`, `providerClientMessageIds`, group identity; không thêm identity ledger/table. `cliMsgId` chỉ là dữ liệu quan sát, không suy từ commandId.
- Recovery crash sau ACK cần trạng thái local bền vững: dự kiến **một JSONB nullable `reconciliation` trên SendAttempt + partial index**, không bảng mới. Legacy null không thành backlog. DDL chỉ áp sau chấp thuận riêng.
- Một public GET by Message pointer bổ sung cho inspect từ Inbox/flow không có original commandId; giữ route by commandId cũ, cùng shared service, không thêm API engine.
- Normalized metadata version riêng; envelope vẫn v1. Writer gate mới đề xuất `ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED=false`; reader cũ strict nên deploy reader trước writer; drain payload mới trước rollback reader.
- Giữ ingestion createdAt/shard identity; provider timestamp riêng. Không dùng random transport eventId thay provider dedupe; không tự đổi chronology toàn Inbox.
- 4 phần tách baseline, nhận tin, reconciliation có DDL, và admission/error. Số file vượt 8 vì các boundary hiện hữu; không thêm lớp/framework để giải quyết một phần nhỏ.

## Trade-offs và extension trace

| Hướng | Giả định/điểm thất bại | Quyết định |
|---|---|---|
| Gọi shared helper từng ID | Helper ghi đè primary và xóa echo/attachment từng lần; không khép crash gap | Loại |
| Opt-in trên repository + attempt/group identity có sẵn | Cần exact IDs; thiếu proof/budget thì giữ dữ liệu và needs_review | Chọn |
| Ledger/engine đa kênh mới | Đụng channel production, tăng query/queue/migration cost | Ngoài scope |

Better approaches: mở rộng hẹp tại boundary hiện hữu tốt hơn sao chép wrapper retry ZaloCRM; giữ no-replay unknown, không thay transport. Hai biến thể thực là DM/group: cùng attempt/outcome nhưng nhóm tiếp tục qua policy/facade riêng. Không xây seam cho sender/provider chưa có.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Baseline, boundaries và RED contract](./phase-01-start.md) | Completed |
| 2 | [Versioned inbound, placeholder, diagnostics](./phase-02-contracts-and-inbound-evidence.md) | Completed (offline contracts) |
| 3 | [Canonical multi-ID reconciliation, durable recovery](./phase-03-canonical-reconciliation-and-recovery.md) | Implemented; verification/rollout pending |
| 4 | [Admission, retry/error API/UI, regression gates](./phase-04-bounded-admission-and-errors.md) | Implemented; verification/rollout pending |

Phụ thuộc thiết kế 01 → 02 → 03 → 04. Người dùng đã yêu cầu triển khai song song; chia owner gateway, durable reconciliation, API/UI và controller theo file, tích hợp tại các boundary hiện hữu.

## Reports

- [TDD matrix: 12 mục, case và gate](./reports/tdd-matrix.md).
- [Ranh giới, ngân sách và verification](./reports/implementation-boundaries.md).
- [Send/recovery research](./reports/send-recovery-research.md), [receive research](./reports/receive-integrity-research.md).
- [Review/validation](./reports/validation.md).

Research là evidence, không tự thành quyết định. Plan không chọn random eventId làm job key, không đổi timeline chung, không suy cliMsgId thành commandId. Các plan socket/media/recall đang có là work riêng; không sửa hoặc phụ thuộc vào implementation chưa tồn tại của chúng.

## Success Criteria

- [x] 12 mục P0.4 có test và phase owner; không mở thêm media sender/native operation.
- [ ] All proven aliases về canonical row, primary/attachment/reply references không mất.
- [x] Crash recovery chỉ sửa local; pending/unknown/applied không auto replay provider send.
- [x] Placeholder đọc được qua public API và UI; không AI/keyword/flow hoặc download.
- [x] Error code/retryAfterMs/safeAction có giới hạn; không raw provider data trong log/API.
- [ ] Shared regression, Edge graph, DB concurrency và budgets đạt khi thực thi.
- [ ] Reader-first, migration approval và rollback gates được kiểm chứng trước production.

## Review / validation

Đã rà soát 3 góc nhìn độc lập (failure/contract, security/facts, assumptions/scope) và hiệu chỉnh các điểm có evidence. 40 source anchors và các source/test paths đã kiểm tra; format CLI validation đạt. Chi tiết findings, quyết định và giới hạn kiểm chứng tại [validation](./reports/validation.md). Không có application test/live proof ở bước lập kế hoạch.

## Trạng thái và bàn giao

Code đã triển khai trong worktree `/Users/jacky/.codex/worktrees/zalo-account-integrity/ChatWorkAI`, branch `feat/zalo-account-message-integrity`, giữ nguyên checkout chính và các socket/session commits trước đó. Xem [implementation evidence](./reports/implementation.md), [gateway](./reports/gateway-implementation.md), [durable reconciliation](./reports/reconciliation-implementation.md), [API/Inbox](./reports/builder-implementation.md).

Không đánh dấu production-ready: PostgreSQL race suite còn opt-in/skipped, live-provider/staging chưa chạy, coverage toàn SDK/gateway chưa đạt80% dù test pass. Giữ nguyên thresholds. Schema/migration chỉ generate/inspect; áp migration cần chấp thuận riêng. Chưa commit/push/deploy.

<!-- slug: zalo-account-message-integrity-recovery-tdd -->
