---
phase: 1
title: "Baseline, boundaries và RED contract"
status: completed
priority: P0
dependencies: []
---

# Phase 1 — Baseline và test bảo vệ

## Goal / context

Khóa đầy đủ P0.4 bằng tests hiện hữu trước khi thay behavior. Đọc [channel docs](../../docs/zalo-account.md), [TDD matrix](./reports/tdd-matrix.md) và hai research reports. Thực thi trong `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`; mọi source path bên dưới tính từ project root.

## Existing guarantees phải giữ

- Attempt được claim trước dispatch; pending/unknown/applied không được resend tự động.
- API chuẩn bị Message identity trước enqueue; Inbox và flow qua cùng integration/send-attempt.
- Shared single-ID echo-before-result đã có test; không coi đây là lý do rewrite generic sender.
- Group persist trả isNew=true cho admitted-unpublished identity dù Message đã tồn tại để recovery publish; giữ semantics này.
- Giữ Connection state, generic delete, queue retry defaults, timeline, quota/MAC và những kênh khác.

## Files to modify khi triển khai

| File | Mục đích |
|---|---|
| `packages/business/__tests__/zalo-account-canonical-send.test.ts` | Preparation, target/hash, stable Message identity |
| `packages/business/__tests__/zalo-account-send-attempt.service.test.ts` | Claim/status/late ACK/no replay |
| `integrations/zalo-account/__tests__/message.test.ts` | Inbox/API/flow text/image/file convergence |
| `apps/worker/__tests__/send-message-handler.test.ts` | Existing single-ID/default behavior, RED Zalo multi-ID |
| `apps/worker/__tests__/send-flow-step.test.ts` | Zalo flow reconciliation, other flows unchanged |
| `apps/worker/__tests__/zalo-account-group-recovery.test.ts` | Bounded scheduler/guard |

Không production service/migration trong phase 1.

## Tests Before — baseline và RED

1. Chạy existing tests từng workspace, ghi failures có sẵn; không sửa ngoài scope.
2. Characterization GREEN: cùng command/input trả cached result; khác input bị chặn; claim trước provider call; applied không bị late failure hạ trạng thái.
3. Characterization GREEN: generic single-ID echo race và đại diện channel khác giữ calls/realtime semantics.
4. RED: một send trả2 IDs; echo thứ2 trước/sau ACK phải hội tụ một logical row sau đối soát.
5. RED: flow direct/group, API direct/group và Inbox đều có local identity để repair, không chỉ mock đúng route.
6. RED: provider applied rồi local reconciliation throw/crash: durable local recovery còn, provider call count không tăng.
7. RED: hai intent cùng text/time khác command không bị gộp; ID trùng giữa account/thread không match.
8. RED: stale completion/late failure không clear ACK mới hoặc unknown evidence.

Mỗi case ghi expected assertion failure và phase sửa. Không đổi test đã GREEN thành RED giả.

## GREEN / Refactor

- GREEN của phase 1 là baseline được bảo vệ và RED chứng minh đúng gap, không yêu cầu fake implementation để mọi test mới pass ngay.
- Dùng deferred promises/barriers/fake timers cho ordering; không sleep thật, không chạy server/queue chỉ để mock behavior.
- Chỉ refactor fixtures cục bộ. Regression mới phải GREEN ở owning phase trước gọi implementation hoàn tất; không skip/weak assertion.

## Tests After / commands

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-canonical-send.test.ts __tests__/zalo-account-send-attempt.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run __tests__/message.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/send-message-handler.test.ts __tests__/send-flow-step.test.ts __tests__/zalo-account-group-recovery.test.ts
```

## Acceptance / tasks

- [x] Baseline và expected RED failures có evidence, không tuyên bố code hiện đã được sửa.
- [x] 12 checklist items và entry points có owner/test trong matrix.
- [x] File boundaries đóng, no framework/queue/global default changes.

## Risks / rollback / next

Mock tests không chứng minh race DB; phase3 phải có opt-in two-client transaction tests. Baseline hỏng ngoài scope được ghi riêng. Rollback chỉ revert tests thuộc task, không reset change của phiên khác. Phase2 nối inbound; phase3 đóng multi-ID/crash; phase4 đóng admission/errors/gates.

## Execution evidence — 2026-11-23

Offline implementation/contract tests đã chạy; xem [implementation report](./reports/implementation.md). Không coi automated contract proof là live rollback/provider proof.
