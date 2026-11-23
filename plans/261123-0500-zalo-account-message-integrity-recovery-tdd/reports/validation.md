# Review và validation — P0.4

Ngày 2026-11-23. Đây là kiểm tra **plan**, không phải kết quả application tests/live provider. Status các phase vẫn pending.

## Verification Results

- Tier: Standard (4 phase); Fact Checker + Contract Verifier, kèm flow/race review có evidence.
- 40 source anchors: verified40, failed0 sau khi đổi assertion public resource sang inheritance createSelectSchema(messageModel); mỗi phase10 anchors.
- 57 test-path references trong proposed commands đã kiểm tra; các file mới được đánh dấu create rõ ràng, không coi là file có sẵn.
- Source/file references hiện có và relative links được kiểm tra lại sau edits; checklist dùng snapshot commit vì checkout bị phiên khác đổi nhánh.
- CLI `ak plan validate` đạt format; `ak plan parse` đọc4 phase, tất cả chưa hoàn thành.
- Chưa chạy lint/typecheck/application tests/build/DB/provider. Không claim concurrency đã verified bằng mock hoặc kế hoạch.

| Phase | Anchor | Evidence |
|---|---|---|
| 1 | `async send(` | VERIFIED `packages/business/src/zalo-account/canonical-send.service.ts:252` |
| 1 | `async assertCanResend(` | VERIFIED `packages/business/src/zalo-account/send-attempt.service.ts:60` |
| 1 | `zaloAccountSendAttemptRepository.claim(` | VERIFIED `packages/business/src/zalo-account/send-attempt.service.ts:110` |
| 1 | `ZaloAccountSendAttempt_scope_key` | VERIFIED `packages/database/src/schema/zalo-account-message-state.ts:180` |
| 1 | `const sendRoutedMessage` | VERIFIED `integrations/zalo-account/src/message.ts:61` |
| 1 | `const firstMessageId = result.messageIds[0]` | VERIFIED `apps/worker/src/chat/handlers/send-message.ts:1387` |
| 1 | `removes a provider echo that arrived before the send result` | VERIFIED `apps/worker/__tests__/send-message-handler.test.ts:736` |
| 1 | `timeoutInSeconds: 50` | VERIFIED `apps/worker/src/schedule/handlers/recover-zalo-group-inbox.ts:16` |
| 1 | `return { isNew: true as const` | VERIFIED `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:253` |
| 1 | `"NX"` | VERIFIED `apps/zalo-account-gateway/src/transport/redis-command-state-store.ts:18` |
| 2 | `onUnsupported: () =>` | VERIFIED `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:471` |
| 2 | `export const zaloAccountDirectMessageSchema` | VERIFIED `packages/sdk/src/lib/zalo-account.ts:228` |
| 2 | `export const zaloAccountGroupMessageSchema` | VERIFIED `packages/sdk/src/lib/zalo-account.ts:253` |
| 2 | `export const normalizeProviderMessage` | VERIFIED `apps/zalo-account-gateway/src/runtime/provider-message.ts:212` |
| 2 | `const clientMessageId` | VERIFIED `apps/zalo-account-gateway/src/runtime/provider-message.ts:146` |
| 2 | `onUnsupported` | VERIFIED `apps/zalo-account-gateway/src/runtime/ports.ts:106` |
| 2 | `IntegrationJobAction.incomingMessageEcho` | VERIFIED `apps/worker/src/events/zalo-account/handler.ts:174` |
| 2 | `replyToGroupMessage` | VERIFIED `apps/worker/src/integration/handlers/zalo-account-group-message.ts:54` |
| 2 | `export const messageResource = createSelectSchema(messageModel` | VERIFIED `apps/builder/src/features/messages/schema/resource.ts:10` |
| 2 | `getZaloGroupMessage` | VERIFIED `apps/builder/src/features/zalo-accounts/lib/group-content.ts:33` |
| 3 | `providerClientMessageIds:` | VERIFIED `packages/database/src/schema/zalo-account-message-state.ts:149` |
| 3 | `async findByProviderMessage` | VERIFIED `packages/database/src/repositories/integration-zalo-account/send-attempt-repository.ts:217` |
| 3 | `zaloAccountSendAttemptService.confirm(input)` | VERIFIED `apps/zalo-account-gateway/src/main.ts:57` |
| 3 | `async reconcileOutgoingSourceId` | VERIFIED `packages/database/src/sharding/message/repository/sharded-message-repository.ts:886` |
| 3 | `getShardForWrite(` | VERIFIED `packages/database/src/sharding/message/repository/sharded-message-repository.ts:410` |
| 3 | `.delete(attachmentModel)` | VERIFIED `packages/database/src/sharding/message/repository/sharded-message-repository.ts:824` |
| 3 | `groupId: bigintAsString()` | VERIFIED `packages/database/src/schema/zalo-account-message-identity.ts:39` |
| 3 | `async markPublished` | VERIFIED `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:256` |
| 3 | `pickPending:` | VERIFIED `packages/business/src/zalo-account/group-inbox.service.ts:19` |
| 3 | `async pendingPrepared` | VERIFIED `packages/database/src/repositories/integration-zalo-account/send-attempt-repository.ts:141` |
| 4 | `60_000` | VERIFIED `packages/business/src/zalo-account/group-rate-limit.ts:41` |
| 4 | `private async waitForResult` | VERIFIED `packages/business/src/zalo-account/transport.service.ts:556` |
| 4 | `kind: z.literal("sync_groups")` | VERIFIED `packages/sdk/src/lib/zalo-account.ts:583` |
| 4 | `recordFailure(` | VERIFIED `apps/zalo-account-gateway/src/transport/provider-admission.ts:46` |
| 4 | `class ZaloAccountPreDispatchError` | VERIFIED `packages/sdk/src/lib/zalo-account.ts:157` |
| 4 | `getSendAttempt:` | VERIFIED `apps/builder/src/features/zalo-accounts/api/operations.ts:81` |
| 4 | `getZaloAccountOperationsAction` | VERIFIED `apps/builder/src/features/zalo-accounts/actions/account-operations.action.ts:17` |
| 4 | `export const MessageErrorBadge` | VERIFIED `apps/builder/src/features/messages/components/message-error-badge.tsx:24` |
| 4 | `zaloAccountSendAttemptService.assertCanResend(` | VERIFIED `packages/business/src/message/resend-outgoing.ts:123` |
| 4 | `const NON_ROUTABLE_PORT = "1"` | VERIFIED `packages/database/__tests__/integration/database-url.ts:2` |

## Quyết định đã kiểm tra

- Source kiểm chứng single-ID reconciliation có sẵn; chỉ multi-ID/late repair cần opt-in. Không rewrite generic sender.
- Reject blanket kết luận group persist-before-publish bị mất: persist trả isNew=true cho admitted unpublished identity; existing recovery có đường publish lại. Kiểm tra side-effect/replay bằng tests thay vì sửa semantics tùy tiện.
- Research đề xuất random eventId làm job key không được chọn: giữ stable provider dedupe để tránh tăng jobs/DB; bounded kind/version discriminator chỉ khi cần placeholder upgrade.
- Giữ ingestion createdAt/shard identity; provider time riêng, không redesign chronology chung.
- Missing identity diagnostic only; valid unsupported placeholder bypasses automation. Không fake Contact/Message.
- cliMsgId không bằng commandId; chỉ exact confirmed provider IDs cho phép alias ownership.
- DDL proof-gated: current pendingPrepared selector không cover applied local repair; dự kiến one nullable JSONB/index, bỏ DDL nếu existing state vượt cùng RED/budget gates.
- Exact canonical/echo addresses và targeted shard contract đã được ghi rõ; không gọi helper lặp làm đổi primary.
- Direct quota60/minute là provisional app cap tham chiếu group limiter; không cap direct đã có, không official Zalo quota. Bỏ arbitrary read/label caps.
- DB command fail-fast isolated test URL qua DATABASE_URL; không mặc định load .env có thể trỏ production.
- Diagnostic/backlog có cap toàn process và per-account; không unbounded callbacks, arbitrary metric labels hoặc per-bubble polling.

## Red Team Review

Đã nhận 3 review độc lập: Failure Mode/Contract, Security/Fact, Assumption/Scope. 9 findings nhóm lại (7 High,2 Medium), tất cả phần có evidence được làm rõ trong plan;0 Critical. Đây là review thiết kế, không execution proof.

| Finding | Evidence | Quyết định / nơi sửa |
|---|---|---|
| DDL phải có RED proof | send-attempt-repository.ts:141, schema/zalo-account-message-state.ts:131 | Accept: proof gate, reuse nếu cùng tests/budgets đạt; otherwise một JSONB/index, phase3 |
| Shard routing phải cụ thể | sharded-message-repository.ts:886 | Accept: canonical/echo addresses, targeted shard contract, no all-shard scan, phase3 |
| Cap direct/proposed và DB command | group-rate-limit.ts:28, integration/database-url.ts:1 | Accept: direct60 provisional, bỏ arbitrary read/label quotas, isolated DB env, phase3/4 |
| Atomic alias/ref contract | message-repository.ts:59, sharded-message-repository.ts:886 | Accept: sorted locks, idempotent non-destructive merge/reparent, no delete thiếu proof, phase3 |
| Published group identity không còn payload | group-inbox-repository.ts:146,253,283 | Accept: dedicated rebindConfirmedOwnEcho, preserve publishedAt, trước destructive cleanup, phase3 |
| ACK winner/conflict return | send-attempt.service.ts:80, send-attempt-repository.ts:194 | Accept: atomic stored winner, same IDs idempotent, different IDs conflict/needs_review, no replay, phase3 |
| Existing sendError có thể chứa provider string | send-message.ts:735,1196, messages/schema/resource.ts:10 | Accept Zalo-only sanitizer trước log/persist/realtime và legacy read projection, phase4. Không sửa OA ZaloSdkException vì không phải owner personal channel |
| UI/public auth chưa cụ thể | account-operations.action.ts:17, api/operations.ts:24 | Accept: preserve UI superAdmin; public channels read_only GET; same safe projection/ownership, explicit403/404 tests, phase4 |
| Raw parsing/gate chưa bounded | provider-message.ts:49,90, zca-client.ts:78, sdk/zalo-account.ts:750 | Accept: cap params/content/depth/keys, no-throw callback, explicit default-off writer gate + legacy serialization, phase2 |

Reviewer ghi validation.md thiếu khi bắt đầu review; file đã được tạo và mọi link được kiểm tra ở final sweep. Không coi đây là blocker còn tồn tại. Không có quyết định explicit của user bị đảo ngược: vẫn full12 mục, không mở media/socket/recall/native sender hoặc framework mới.

## Whole-Plan Consistency Sweep

Kiểm tra lại plan index,4 phase, matrix,boundaries và source snapshot sau mọi correction. New proposed paths (component/tests/migration) được phân biệt với existing files; không source implementation nào được thực hiện trong tác vụ này. Deltas checked: DDL proof gate, exact shard/address contract, published rebind/cleanup ordering, ACK winner, direct cap semantics, isolated DB env, error sanitizer/auth, raw-size/gate và by-message inspect. Unresolved plan contradictions:0; runtime/provider behavior vẫn là execution/staging gates, không được báo đã pass.

## Questions và handoff

Không có câu hỏi sản phẩm bắt buộc: scope, isolation, no-replay và giới hạn tài nguyên đã rõ từ yêu cầu; các lựa chọn nhỏ được chốt bằng source evidence. Runtime/provider uncertainty được đặt thành TDD/staging gates, không bắt user chọn điều code có thể chứng minh. Implementation chỉ bắt đầu khi user yêu cầu; migration apply vẫn cần chấp thuận riêng.

## Final artifact checks

- PASS:11 Markdown docs trong plan directory;4 phase pending, có Tests Before/Refactor/Tests After, exact commands và rollback.
- PASS: mọi relative link và source path trong execution files tồn tại hoặc được đánh dấu create/generated;57 test references trong runnable command lines đúng existing/new path.
- PASS: ak plan validate; parse nhận4 phase và0 task hoàn thành. Không tạo task/thread/goal mới hoặc pin shared worktree.
- PASS: không tracked source diff do tác vụ này; source/checklist commit được ghi rõ thay vì reset checkout của phiên khác. git diff --check không báo whitespace errors trên tracked diff.
- Unrun: lint/types/application tests/build/real DB/provider. Đây là plan delivery, không implementation verification.
