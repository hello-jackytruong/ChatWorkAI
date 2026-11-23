---
title: "Zalo Account: giữ original và tracking thu hồi — TDD"
description: "Kế hoạch P0 · 3 giữ original, xử lý recall bền vững và native operations riêng Zalo Account."
status: in-progress
priority: P0
effort: "8–12 ngày kỹ thuật, chưa gồm thời gian chờ provider proof"
tags: [feature, database, backend, api, frontend, security]
branch: feat/zalo-account-recall-tracking
blockedBy: []
blocks: []
created: 2026-11-23
---

# Zalo Account: giữ original và tracking thu hồi

## Outcome và phạm vi

Hoàn thành **toàn bộ R01–R16 của P0 · 3** trong [scope đã chốt](reports/scope-and-decisions.md): recall chỉ đổi trạng thái đúng tin; original/file đã lưu vẫn xem được theo quyền Inbox; có API + UI cho local hide, native recall, delete-only-me và deleteChat. Đây là **PLAN ONLY**; chưa triển khai, chạy test, migration hoặc provider thật.

## Constraints và non-goals

- Chỉ Zalo Account; giữ nguyên shared delete/reply, Connection, mọi channel khác và group identity/send-attempt schema hiện có.
- Tối đa hai bảng metadata hẹp trên main DB; không copy body/blob, không archive framework, queue/daemon mới, full scan/fan-out không giới hạn hoặc bulk backfill.
- Tận dụng Message/Attachment, gateway/worker/realtime/audit hiện có; API trước UI, public/private cùng service và ACL đọc conversation hiện có.
- Receipt/reaction giữ latest-state hiện có và cửa sổ 90 ngày; original/recall không có TTL mới. Explicit purge thắng retention.
- Không làm P0 · 2/full ingestion: chỉ file R2 đã tồn tại; bytes chưa lưu trả unavailable. Không mở sửa tin, group moderation hoặc thêm permission bit.

## Phases tuần tự

| # | Phase | Trạng thái | Phụ thuộc | Effort |
|---|---|---|---|---|
| 1 | [Lifecycle, exact mutation và recovery hữu hạn](phase-01-start.md) | Implemented; DB proof pending | Không | 3–5 ngày |
| 2 | [Native operations và original service/public API](phase-02-native-operations-and-original-api.md) | Implemented; live proof pending | Phase 1 | 3–4 ngày |
| 3 | [Inbox, regression, security và rollout](phase-03-inbox-and-regression-gates.md) | Implemented; final gates pending | Phase 1–2 | 2–3 ngày |

## Acceptance criteria

- [ ] R01–R16 có RED → GREEN → Refactor → Tests After; DM/group recall trước original có placeholder ổn định, original tới muộn không hồi sinh hoặc kích hoạt automation.
- [x] Recall giữ body/attachments và receipt/reaction; chỉ target tuple thay đổi, replies và channel khác giữ behavior đã characterization.
- [x] Crash/race/shard unavailable để pending có thể repair; mỗi tick có cap/deadline/cursor, không cutoff correctness theo 90 ngày.
- [x] Original/list/detail/preview/quote/realtime có ACL/redaction đúng; signed URL chỉ qua endpoint authorized; audit không chứa body/URL và chỉ best effort.
- [x] Đủ API machine-usable cho mọi operation; native gate mặc định tắt, command dedupe, onlyMe=true, deleteChat giữ CRM history, unknown không replay.
- [ ] Lint → types tuần tự → tests → coverage 80% không bypass; DB opt-in riêng, migration chỉ apply sau approval rõ ràng.

## Dependencies, trade-offs và giới hạn

P0 · 2 chưa hoàn thành nên không hứa phục hồi file chưa ingest; không phụ thuộc nó để làm đủ original text và file có sẵn. Pinned `zca-js@2.1.2` + staging disposable DM/group proof là điều kiện bật native, không phải lý do bỏ implementation. Main/shard không có atomic transaction chung: durable intent + stable tuple + exact idempotent projection thay cho transaction giả. Hai ledger hẹp tránh sửa schema group/send recovery; đổi lại có thêm lookup batch theo trang. Projection bảo vệ dữ liệu trả về sau recall; URL/cache đã phát trước đó không thể thu hồi tức thì bằng hạ tầng hiện tại.

## Red Team Review và Validation

Đã đối chiếu source và review3 lens; corrections được ghi tại [validation/adjudication](reports/validation.md), [30 anchors](reports/verified-anchors.md). Không có runtime/code verification trong lượt lập kế hoạch. Task state ở checkbox; xem [báo cáo triển khai và gate](reports/implementation-api-ui.md).

## Nguồn và handoff

- [Scope/so sánh phương án/R01–R16](reports/scope-and-decisions.md)
- [Persistence, SDK, concurrency và purge evidence](reports/persistence-research.md)
- [API/UI, ACL, media và audit evidence](reports/api-ui-research.md)
- [Ma trận R/T và ngân sách shared recovery](reports/tdd-and-resource-matrix.md)
- [Checklist hiện tại](../../docs/zalo-account-checklist.md), [Zalo Account](../../docs/zalo-account.md), [invariants](../../docs/agents/invariants.md)

Đã triển khai trong worktree riêng theo yêu cầu ngày 2026-11-23. Các gate coverage, DB integration và live provider proof chưa đủ bằng chứng vẫn để pending; chưa commit/merge/deploy hoặc áp dụng migration.

<!-- slug: zalo-account-recall-tracking-tdd -->
