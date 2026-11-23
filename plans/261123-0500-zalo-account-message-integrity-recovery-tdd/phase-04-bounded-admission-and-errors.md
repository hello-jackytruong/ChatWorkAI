---
phase: 4
title: "Admission, retry/error API/UI và regression gates"
status: in-progress
priority: P0
dependencies: [1, 2, 3]
---

# Phase 4 — Admission, lỗi rõ ràng và release gates

## Goal / decisions

Chặn quota/cooldown trước provider call, truyền machine-readable errors và safe recovery action qua API/UI. Không triển khai media archive/socket redesign.

- Giữ provider status pending/applied/failed/unknown; local reconciliation object riêng. Unknown không được hiện như confirmed failed/resendable.
- Zalo error metadata: enum code, phase `validation|preparation|admission|dispatch|reconciliation|receive`, bounded retryAfterMs và safeAction `inspect|retry_read|new_attempt|none`.
- Read retry khác write replay. Send/update_labels đã có thể đến provider luôn unknown/no replay kể cả network/auth error.
- Giữ group60/account/minute,10/group/minute; thêm direct admission ở actual dispatch, không double charge nhóm. Các cap là operational defaults, không tuyên bố hạn mức do Zalo cấp.
- Không thêm sender mới; tests bảo vệ mọi sender hiện hữu/future extension phải qua canonical chokepoint.

## Files to modify/create khi triển khai

Source root `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`.

| File | Purpose |
|---|---|
| `packages/business/src/zalo-account/group-rate-limit.ts` | Reuse atomic Redis buckets, structured delay |
| `packages/business/src/zalo-account/group.service.ts` | Policy và consumeCapacity đúng1 lần |
| `apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts` + `src/main.ts` | Wire direct pre-dispatch admission |
| `apps/zalo-account-gateway/src/transport/provider-admission.ts` | Bounded circuit state, cooldown metadata |
| `apps/zalo-account-gateway/src/transport/command-executor.ts` | Exhaustive operation safety map/read retry |
| `packages/sdk/src/lib/zalo-account.ts` | Zalo-specific error/result metadata, legacy readers |
| `packages/business/src/zalo-account/transport.service.ts` | Preserve typed error metadata, no parsing delay from string |
| `packages/business/src/zalo-account/send-attempt.service.ts` + `canonical-send.service.ts` | Safe outcomes/reconciliation inspect |
| `apps/worker/src/chat/handlers/send-message.ts`, `send-flow-step.ts` và `packages/business/src/message/list-for-conversation.ts` | Zalo-only error sanitization trước persistence/log/realtime và read projection; defaults khác giữ nguyên |
| `apps/builder/src/features/zalo-accounts/api/operations.ts` + `schema/errors.ts` | Additive getSendAttempt/error contract |
| `apps/builder/src/features/zalo-accounts/actions/account-operations.action.ts` | Thin authorized UI inspect action, same service |
| `apps/builder/src/features/messages/components/zalo-message-evidence.tsx` + `message-item.tsx` | Zalo status/failure actions only |
| `apps/builder/messages/en.json` + existing locale catalogs | Translated labels/actions |
| `docs/zalo-account.md` | Owning behavior/ops docs sau implementation |

Nếu cần helper direct admission, dùng local function/module Zalo, không service class/package mới. CLI/MCP derive spec; không sửa client engines. Public API contract có trước corresponding UI trong từng phase.

## Tests Before — RED

1. Direct bucket hết: zero zca calls, typed code/retryAfter xuyên gateway→transport→API/UI.
2. Group giữ60/10, consume1 lần; failed policy không tiêu quota.
3. Redis unavailable: fail closed trước send, không mở provider circuit vì provider chưa được gọi.
4. Circuit account A không chặn B trừ provider-wide pause; TTL/cap được test.
5. Pure read retry<=2 total attempts, recheck fence/deadline/admission; send/update_labels không replay.
6. Media preparation fail trước provider là failed/preparation; timeout sau possible dispatch là unknown.
7. Late applied ACK sau UI unknown cập nhật applied/local pending/completed, clear stale send-error đúng lúc mà không send lại.
8. Pending/unknown/applied không resend ở UI lẫn server; inspect hoạt động khi sending disabled. needs_review không tự tạo command mới.
9. Public cross-workspace/scope sai không đọc attempt/diagnostic; old clients giữ fields/status/method cũ. Test UI non-superAdmin, read_only channels token, wrong account/group/contact và error/status parity.
10. Non-Zalo tooltip/sendError/resend và shared retry không đổi.

## GREEN — steps

1. Exhaustive safety switch theo current command kinds: sync_groups/sync_friends/get_labels pure reads; send_direct/send_group/update_labels writes; QR/reconnect/stop/typing không auto áp read retry. Không thêm generic operation framework.
2. Read retry trong existing executor claim, tối đa thêm1 lần, delay<=250ms, trong original deadline; recheck fence/owner/admission mỗi attempt. Không new command ID/job mỗi lần.
3. Extend Zalo pre-dispatch error/result, giữ legacy error string. Không sửa global SdkException/ParsedError behavior của provider khác.
4. Direct admission dùng atomic Redis account bucket tại trước zca call; default60/minute **đề xuất**, tham chiếu account bucket của existing group limiter (không phải cap direct đã có), một cấu hình tập trung Zalo nếu cần. Group60/10 giữ nguyên và không charge thêm direct bucket. Read/typing/labels không dùng send bucket; giữ typing1/thread/5s. Stop/disconnect không bị send limiter chặn.
5. Phân loại nhóm thao tác send/read/typing/label/lifecycle ngay trong safety switch, giữ existing circuit và per-account serialization. Không tự thêm read/label quotas hoặc knobs chưa có evidence. Read retry vẫn phải qua admission và có giới hạn; label write version/fencing/no-replay giữ nguyên. Lifecycle stop/disconnect không bị send cap chặn. Nếu RED chứng minh cần cap cho nhóm khác, bổ sung tối thiểu và ghi rõ lý do trước implementation, không âm thầm đổi quota.
6. Circuit account map TTL prune + hard cap4096 entries; prune bounded<=64 entries/lượt, tối đa1 sweep/30s, expire-on-access cho entry đang dùng, không full-map scan mỗi send; evict expired trước. Khi hết chỗ thì structured busy/retryAfter, không memory tăng vô hạn hoặc fail-open.
7. Trước recordMessageSendError/logger/failed-event, Zalo-only sanitizer chuyển arbitrary provider error.message/stack thành safe enum message/code; không chỉ truncate. Áp vào send-message và flow catch, cả unresolved branch. Read projection theo channel=Zalo tại list/get/realtime cũng sanitize legacy sendError/status fields; giữ original supported customer text/media, không rewrite DB nội dung khách. Không sửa ZaloSdkException chung của OA. RED sentinel URL/body/secret qua persistence, Error Log, messages.list/get, realtime và UI. Safe errors lưu nhỏ trong existing Zalo Message attributes và single attempt reconciliation JSONB (sendError object, state not_required nếu failed trước provider); getOutcome lấy safe error từ attempt ngay cả khi chưa tạo Message; no raw stack/body/URL/auth. Error Log reuse với dedupe/sample, không tạo row mới cho mỗi duplicate flood.
8. Permission matrix: UI inspect giữ `requireWorkspacePermission(workspaceId, "superAdmin")` như existing Zalo actions; user không có quyền không thấy action và server403. Public GET dùng channels-scoped workspace token, read_only được phép; thiếu scope403, ownership/target mismatch404, không lộ existence. Authorized credentials cho cùng target phải nhận cùng sanitized projection, không đồng nhất nhầm credential policies. Extend getSendAttempt additively: status/messageIds hiện hữu giữ, thêm optional reconciliation + error metadata. messages.list/get mang safe marker để UI không đoán bằng sendError text. Public và action gọi same service, giữ channels token scope và account/workspace checks. UI không được tự suy original commandId từ scoped hash: thêm selector by Message id+createdAt vào shared inspect method (existing indexed message pointer), check Message thuộc account Inbox và scope. Vì UI của Inbox/flow không luôn có original commandId, thêm public counterpart read-only `GET /v1/zalo-accounts/{accountId}/messages/{messageId}/send-attempt` với required messageCreatedAt query gọi cùng method; existing getSendAttempt route giữ nguyên. Chọn latest relevant attempt bounded<=2 candidates, conflict thì explicit inspect state, không chọn failed cũ che pending mới. Một procedure nhỏ trong operations.ts, không API engine mới; spec/CLI collision tests bắt buộc.
9. Localized UI: pending “Đang xác nhận”; unknown “Chưa xác định kết quả — kiểm tra trạng thái”; failed “Chưa gửi được” + reason; applied+local pending “Đã gửi, đang đối soát”. Inspect không send; explicit new intent chỉ cho proven predispatch failure qua existing server guard.
10. No per-message polling. Realtime hiện có; inspect khi user thao tác hoặc một panel active có tối đa1 in-flight request. TanStack invalidate/setQueryData, không router.refresh thay cache invalidation.
11. Lỗi nhận và current preparation/storage failure hiển thị khi có evidence; không tạo giả trạng thái incoming R2 mirror chưa triển khai. Một media failed không xóa tin/caption đã lưu.

## Refactor / Tests After

Giữ typed additions Zalo-local; không global error-parser changes. Unit dùng fake clock và spies; atomic limiter/recovery concurrency có opt-in real Redis/DB tests riêng.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-admission.test.ts __tests__/command-executor.test.ts __tests__/zalo-account-pool.test.ts __tests__/redis-command-consumer.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-transport.service.test.ts __tests__/zalo-account-send-attempt.service.test.ts __tests__/zalo-account-canonical-send.test.ts __tests__/zalo-account-group.service.test.ts __tests__/message-resend-outgoing.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-accounts-public-api.test.ts __tests__/zalo-accounts-action-permissions.test.ts __tests__/zalo-account-message-evidence.test.tsx __tests__/resend-message-button.test.tsx __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts __tests__/edge-instrumentation-graph.test.ts
```

Nếu helper mới cần test riêng: create `packages/business/__tests__/zalo-account-send-admission.test.ts` trước implementation. Public tests phải assert UI/public equality, safe result và ownership; không đổi method/scope chỉ để dễ gọi.

## Final gates / tasks

- [ ] RED/GREEN evidence mỗi phase; DB skip không tính pass.
- [ ] Lint→touched types→affected tests→coverage theo boundary report; không bypass80% threshold/hooks.
- [x] Shared send/flow/receive/resend regression, representative non-Zalo fixtures và Edge graph GREEN.
- [ ] Fault tests: Redis result write fail, core DB/shard down, repeated ACK/jobs, gateway/worker restart.
- [x] Ambiguous send provider spy vẫn1 call; no post-dispatch write retry.
- [ ] Batch/deadline/query/heap/log cardinality caps đạt; không N+1 polling hoặc full-history scan.
- [x] Apply cli-mcp-docs khi implementation xong; spec/docs/live tools kiểm chứng nếu môi trường có.
- [ ] Bounded staging account verifies actual multi-ID/echo contracts; không bulk send hoặc claim unit=live proof.
- [ ] DDL review và approval trước áp, additive schema trước app, readers trước writer.

## Rollback / stop rules

Tắt producer mới/local repair/admission extension độc lập nếu lỗi, giữ no-replay và attempt dữ liệu. Không fail-open limiter để test pass. Drain new payloads trước old-reader rollback. Không tự chuyển unknown thành resendable khi disable repair. Nếu cần đổi generic defaults/engine đa kênh để pass, dừng và báo scope. Nếu provider không cho deterministic match, giữ inspect/needs_review, không ghép heuristic để giả hết duplicate.

## Execution evidence — 2026-11-23

API/UI/admission/error code đã triển khai; offline spec/collision/Edge regression có evidence trong [implementation report](./reports/implementation.md). Coverage toàn SDK/gateway vẫn không đạt80%, không bypass hoặc nới threshold. DB thật/live provider/restart staging và migration approval còn mở; chưa production-ready.
