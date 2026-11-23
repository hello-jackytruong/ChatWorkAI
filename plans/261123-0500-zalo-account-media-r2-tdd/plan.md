---
title: "Zalo Account media R2/S3 — full P0 · 2 TDD"
description: "Kế hoạch TDD đầy đủ cho lưu media Zalo Account trên R2/S3, giữ nguyên hành vi các kênh khác."
status: in-progress
priority: P0
effort: 40h
branch: feat/zalo-account-media-r2
tags: [zalo-account, media, r2, s3, tdd]
created: 2026-11-23
blockedBy: []
blocks: []
---

# Kế hoạch P0 · 2 — media Zalo Account

## Kết quả và biên

Hoàn thành đủ 24 mục M01–M24 của [coverage-matrix](./reports/coverage-matrix.md): bản gốc private, biến thể hữu ích, descriptor inbound, own-echo/DM/nhóm/history-shaped, avatar/cover/sticker, trạng thái/retry, đọc có quyền, backfill, đối soát và purge bounded. `source_missing` là trạng thái trung thực khi provider không cung cấp nguồn; không đánh dấu đã lưu.

Không làm history crawler, video/voice send API, player/picker UI, profile editor, native revoke/delete, FFmpeg hay generic media framework. Không đổi Attachment/Message shard DDL và không đổi behavior Messenger/WhatsApp hay kênh khác.

## Thiết kế tham chiếu (đề xuất, chưa được user phê duyệt)

Hai bảng main DB chỉ cho Zalo (`ZaloAccountMediaAsset`, `ZaloAccountMediaReference`), một business service, một queue dedicated chạy trong process low hiện có; asset row là durable outbox, không có operation/run table thứ ba. Queue dùng `Queue.setGlobalConcurrency(1)`, worker concurrency=1; spool stream + checksum + known-length single PUT qua uploader, không multipart. Asset/reference dùng CAS lease, object key immutable theo checksum, private workspace/account prefix. Main DB → shard là saga có intent trước ACK, bind/recover sau mỗi boundary; không giả vờ transaction nguyên tử. Derivative độc lập; duration provenance `provider|detected|unknown`, thiếu thì `null`.

## Phases và dependency

| Phase | Effort | Deliverable | Depends on |
|---|---:|---|---|
| [Phase 01 — Start](./phase-01-start.md) | 12h | schema, service/repository seam, safe streaming transport, queue contract | design review; existing uploader/low worker |
| [Phase 02 — Ingress and capture](./phase-02-ingress-and-resource-capture.md) | 12h | typed capture, intent-before-ACK, originals/derivatives, echo/avatar/sticker | 01 schema + queue |
| [Phase 03 — Reads and maintenance](./phase-03-reads-and-bounded-maintenance.md) | 10h | scoped reads, signed download, retry/backfill/reconcile | 01–02 persisted identities |
| [Phase 04 — Purge and verification](./phase-04-purge-and-production-verification.md) | 6h | purge/retention, races, production gates and rollback | 01–03; migration approval |

## Acceptance gate

All implementation checkboxes remain unchecked until RED tests fail before code, GREEN tests pass after code, then REFACTOR and full gate pass: `pnpm lint` → sequential touched `check-types` → focused tests → coverage ≥80%. Every phase lists exact files/actions, commands with `VITEST_MAX_WORKERS=1`, security/resource budgets, risks/signals and rollback. Migration SQL is generated/inspected only; `db:migrate` requires explicit approval. Disable-by-default must preserve stored reads and must not delete tables/objects on rollback.

## Source and review records

Read [scope-and-design.md](./reports/scope-and-design.md) (proposed contract), [research-evidence.md](./reports/research-evidence.md), [coverage-matrix.md](./reports/coverage-matrix.md), and controller-owned [review-and-validation.md](./reports/review-and-validation.md). Implementation must re-check the cited source paths/lines because concurrent socket/integrity/recall plans may expose only narrow integration contracts; do not import their broader scope.

## Red Team Review và Validation Log

Ba góc rà soát đã có10 finding có source evidence; đã cập nhật hợp đồng và phases theo [review record](./reports/review-and-validation.md). [Commands](./reports/verification-commands.md) là gate khi implementation, chưa được chạy trong lượt lập kế hoạch. Task tracking giữ trong28 checkbox của phase files vì runtime không có task-management surface phù hợp; không đổi active-plan pin của các chat khác.

Implementation chỉ bắt đầu khi có yêu cầu riêng; handoff bằng đường dẫn tuyệt đối của plan.md này, không dựa vào active-plan pin. Báo cáo review ghi rõ gate staging/DB nào chưa chạy.

## Implementation status — 2026-11-23

Phases 01–03 đã triển khai và qua local gate. Phase 04 đã có code/purge/recovery và unit gate; còn migration staging, DB/EXPLAIN, hai replica/R2 thật và release evidence. Xem [kết quả và giới hạn kiểm chứng](./reports/implementation-and-verification.md). Không đánh dấu các gate live đã hoàn tất.
