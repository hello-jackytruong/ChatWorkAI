# Implementation boundaries, budgets và gates

## Ownership / không ảnh hưởng channel production

Chỉ Zalo opts into alias/evidence/error paths. Existing single-ID reconciliation, generic send-error cleanup, resend, timeline và Connection state giữ nguyên cho channel khác. Không đổi `.default()` shared queue hoặc global SDK error parser. Không sửa code ZaloCRM; chỉ tham khảo.

Shared edits dự kiến phải có negative contract tests:

- Message repository interface/implementation: missing alias option chạy behavior cũ, không query alias arrays.
- business Message service: pass-through optional contract, không changed defaults.
- worker send-message/send-flow-step/received-message/incoming-message: channel=Zalo + validated marker/attempt mới vào branch, other-channel mock call shape giữ nguyên.
- Message UI: parser/renderer guard Zalo marker, old messages/components giữ nguyên.
- SDK Zalo subpath: không Node-only import rò router graph; không dynamic import trong packages/worker/integration.

## Scope exclusions / overlap

Không sửa socket reconnect machine; không mirror incoming R2; không retained-undo UI/native delete; không sender/player/history mới. Media errors ở đây chỉ current prep path hoặc safe future evidence contract. Các sibling plans socket/media/recall không phải prerequisites đã implementation; phối hợp file SDK/runtime/Message UI trước khi thực thi, không tự thực thi song song.

Operational attempt/identity state không phải resource người dùng build/template-copied; không copy vào template. Một cột JSONB mới chỉ tạo sau RED proof và không thêm FK; giữ existing SendAttempt purge/index ownership. Nếu scope thực tế thêm table/FK phải dừng để bổ sung purge/template decision, không lén mở rộng.

## Budgets

| Surface | Trần |
|---|---|
| Provider aliases / observed client IDs | <=10 mỗi array/attempt |
| Automatic reconciliation | <=20 attempts/tick, tuần tự, budget5s trong existing40s tick/50s lock |
| Per-attempt repair | <=20 echo rows,<=100 reply refs,<=2 known shard windows,<=24h automatic horizon |
| Retry repair | <=3 rồi needs_review, CAS revision bảo vệ; metadata JSONB<=8KiB/attempt |
| Pure read retry | <=2 total, delay<=250ms, original command deadline |
| Writes possible dispatched | 0 automatic replay |
| Group quotas | preserve60/account/minute và10/group/minute, no double charge |
| Direct quota | provisional60/account/minute trước SDK, staging verified app cap |
| Diagnostics | <=16 reason keys/process,<=2KiB metadata, aggregate<=1 flush/60s |
| Event queue | cap<=20 pending/account,<=1MiB/account,<=200 callbacks/16MiB toàn process; không buffer thứ hai |
| UI inspect | no per-bubble polls,<=1 in-flight active-panel request |
| Existing transport | giữ stream/DLQ10000, TTL24h, batches20,max deliveries5 |
| Local test/type resources | Vitest1 worker, workspaces tuần tự, types lần lượt; không bare turbo all |

Không log raw content/JSON/cookie/IMEI/user-agent/URLs. Pino error `{ err }` chỉ với error object đã sanitize khi provider có thể nhét payload/URL vào message. Counter/cardinality keys không lấy arbitrary UID/msgType. Các trần mới là thiết kế đề xuất, không benchmark đã đo hoặc official Zalo limit.

## Current source anchors cho implementation

- `packages/business/src/zalo-account/send-attempt.service.ts:52` scoped identity; `:116` send/claim; `:149` no-replay outcome handling.
- `packages/database/src/schema/zalo-account-message-state.ts:131` attempt arrays/indexes.
- `apps/worker/src/chat/handlers/send-message.ts:1379` first-ID reconciliation; existing race test `apps/worker/__tests__/send-message-handler.test.ts:736`.
- `packages/database/src/sharding/message/repository/sharded-message-repository.ts:886` source overwrite + echo delete trên write shard; opt-in path phải dùng canonical timestamp.
- `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:87` attempt lookup; `:252` admitted unpublished isNew true.
- `apps/zalo-account-gateway/src/runtime/provider-message.ts:212` direct parse; `zalo-account-runtime.ts:471` unsupported no-op.
- `packages/sdk/src/lib/zalo-account.ts:228` strict message schema; transport envelope version là contract khác.
- `packages/business/src/zalo-account/group-rate-limit.ts:28` atomic capacity,60/10.
- `apps/zalo-account-gateway/src/transport/command-executor.ts:141` circuit delay string; `:167` unknown writes.
- `apps/worker/src/schedule/handlers/recover-zalo-group-inbox.ts:21` existing deadline/recovery.

## Final verification khi thực thi (chưa chạy ở bước plan)

Focused RED loops theo từng phase. Khi GREEN, gate repository theo thứ tự lint → types → affected tests → coverage:

```bash
pnpm lint
pnpm --filter @chatbotx.io/sdk check-types
pnpm --filter @chatbotx.io/database check-types
pnpm --filter @chatbotx.io/business check-types
pnpm --filter @chatbotx.io/worker-config check-types
pnpm --filter @chatbotx.io/integration-zalo-account check-types
pnpm --filter zalo-account-gateway check-types
pnpm --filter worker check-types
pnpm --filter builder check-types
```

Chỉ chạy typecheck workspace thực sự touched và downstream cần thiết; tuần tự, không turbo default parallel. Touched affected tests/coverage chạy từng workspace theo test paths trong phase, dùng `VITEST_MAX_WORKERS=1 pnpm --filter <workspace> exec vitest run <paths>`; coverage thêm `--coverage`, giữ threshold80%, không dùng skip thresholds. Global coverage có thể fail vì phạm vi selected nhỏ: báo rõ, mở rộng owning workspace một lần hoặc cấu hình coverage include cho owning files đúng chuẩn repo, không tắt threshold.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/send-message-handler.test.ts __tests__/send-flow-step.test.ts __tests__/integration-worker-incoming-message.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/message-resend-outgoing.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/resend-message-button.test.tsx __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts __tests__/edge-instrumentation-graph.test.ts
```

Nếu shared paths touched sâu hơn assumptions, mở rộng regression vào actual impacted tests, không chạy toàn monorepo lặp vô cớ. Worker/gateway build một lần khi SDK/runtime exports/tsdown graph thay đổi. DB drift/lint + generated SQL review; never automatically db:migrate. DB opt-in đã xác minh: realDatabaseUrl đọc DATABASE_URL, port1 sentinel bị skip; preset chỉ bổ sung khi env chưa đặt. Dùng fail-fast ZALO_ACCOUNT_TEST_DATABASE_URL trỏ isolated test DB như phase3, không mặc định load .env production. Không claim skipped test là pass.

## Rollout / rollback

1. Review additive migration SQL/index và user approval riêng trước áp. Code đọc cột mới chỉ deploy sau DDL.
2. Deploy readers first; proposed ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED=false ở gateway env/main→pool→runtime/publisher, legacy serialization khi off hoặc gateway last sau khi mọi reader upgraded. Không implicit mixed-version support chỉ vì field optional.
3. Bounded staging DM/group multi-ID, phone-app own-echo, Redis/DB failures và no-replay; không bulk production test.
4. Enable một account cohort nhỏ, theo dõi unknown/reconcile pending/needs_review, lag và memory. Đây là rollout gate, không task triển khai tự động trong plan authoring.
5. Rollback tắt writer/local repair mới, giữ data/schema, drain newer jobs trước old-reader rollback; preserve no-replay và các channel khác.
