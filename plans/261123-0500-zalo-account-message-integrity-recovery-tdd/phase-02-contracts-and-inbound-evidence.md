---
phase: 2
title: "Versioned inbound, placeholder và diagnostics"
status: completed
priority: P0
dependencies: [1]
---

# Phase 2 — Nhận tin có identity và dấu vết lỗi

## Goal / requirements

Supported messages giữ đường hiện hành. Unsupported có identity được lưu/hiển thị một placeholder an toàn. Missing identity tạo diagnostic, không Contact/Message giả. Không đưa placeholder vào automation, AI hoặc last-user-input.

## Contracts và compatibility

- Envelope vẫn `version:1`. Normalized metadata có `schemaVersion:1` riêng; reader chấp nhận vắng marker như legacy v1. Không đổi enum content/channel chung.
- Preserve provider/client ID, thread ID/type, sender, recipient khi có, isSelf, provider timestamp, msgType, quote/mention và version trong Zalo attributes.
- Marker `unsupported` có enum reason `unsupported_content|invalid_content|unsupported_schema`. Không raw JSON/body/URL/attachment payload trong placeholder.
- Identity tối thiểu: trusted route + thread/message/sender + timestamp hợp lệ; missing/unsafe number ID/peer mâu thuẫn → diagnostic `missing_identity|invalid_identity|invalid_fields`, không fabricate.
- So isSelf với verified own UID ở runtime; contradiction không được đoán peer hoặc tự biến contact thành account chính chủ.
- Unknown schema: chỉ dùng separately validated identity header cho placeholder; không ép toàn unknown payload qua known parser.
- Giữ ingestion createdAt/shard key. Provider time ở metadata; activity không lùi. Không đổi thứ tự toàn Inbox hoặc hồi tố shard.
- Giữ stable provider job identity. Chỉ thêm bounded kind/version discriminator nếu cần placeholder→supported upgrade; không random eventId/content hash khiến mỗi retry tạo job mới.
- Reader-first bắt buộc vì old schemas strict: nâng workers/business/UI trước gateway writer. Gate cụ thể đề xuất mới: `ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED=false`, khai báo trong gateway env, inject từ main vào runtime/fenced publisher. Gate off phải serialize đúng legacy wire (omit new defaults/marker), không chỉ parse bằng new schema rồi emit default fields; không settings screen mới. Drain newer payloads trước rollback old reader.

## Files to modify/create khi triển khai

Source root: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`.

| File | Action/purpose |
|---|---|
| `packages/sdk/src/lib/zalo-account.ts` | Modify Zalo parsers/types, legacy/version handling |
| `apps/zalo-account-gateway/src/env.ts`, `src/main.ts` và `.env.example` | Modify một writer flag default off, wiring/rollout docs |
| `apps/zalo-account-gateway/src/runtime/provider-message.ts` | Modify supported/unsupported/invalid normalization |
| `apps/zalo-account-gateway/src/runtime/zca-client.ts` | Pass bounded evidence + verified identity context |
| `apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts` | Propagate messageIntegrityEnabled option từ main tới runtime, default false |
| `apps/zalo-account-gateway/src/runtime/ports.ts` | Modify callback type và implementors/tests |
| `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts` | Replace onUnsupported no-op, bounded publish errors |
| `apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts` | Reuse fenced publishing, same envelope family |
| `apps/worker/src/events/zalo-account/handler.ts` | Zalo-only routing/dedupe for evidence |
| `integrations/zalo-account/src/message.ts` | Preserve direct attributes/classification |
| `apps/worker/src/integration/handlers/incoming-message.ts` | Zalo marker guard before automation, default unchanged |
| `apps/worker/src/integration/handlers/zalo-account-group-message.ts` | Skip group automation for placeholder |
| `packages/business/src/zalo-account/group-inbox.service.ts` | Same durable/policy facade for placeholder |
| `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts` | Preserve normalized evidence, stable row/recovery |
| `apps/builder/src/features/zalo-accounts/lib/group-content.ts` | Legacy/versioned read helpers |
| `apps/builder/src/features/messages/components/zalo-message-evidence.tsx` | Create small Zalo-only component |
| `apps/builder/src/features/messages/components/message-item.tsx` | Zalo render branch, others unchanged |
| `apps/builder/messages/en.json` + existing locale catalogs | Missing i18n keys only |

Nếu typed queue payload cần sửa: chỉ Zalo types trong `packages/worker-config/src/queues/integration/index.ts`. Không thêm queue/job type nếu existing direct/group routes đáp ứng. Audit `packages/event-bus/src/event-bus.ts` strict transport parse để reader update thực sự đi qua event bus, không chỉ unit normalizer. Public read dùng existing messages.list/get, không raw-payload endpoint mới.

## Tests Before — RED matrix

| Case | Expected assertion |
|---|---|
| Legacy không marker | Parse/render như cũ |
| Supported v1 direct/group | Đủ identity; quote/mention/media không đổi |
| Unsupported valid identity | Một placeholder; không raw body/URL/download |
| Missing/unsafe ID, invalid fields, peer conflict | Diagnostic; không fake Contact/Message |
| Duplicate/retry placeholder | Không thêm row, không AI/keyword/flow/send/last-user-input |
| Supported evidence sau placeholder cùng provider ID | Update một logical row, không rerun automation |
| Unknown schema identity hợp lệ/không hợp lệ | Placeholder hoặc diagnostic, không silent drop/crash |
| Old strict reader nhận new writer | Chứng minh incompatibility; gate chặn writer sớm |
| Redis publish fail | Observable bounded retry, không fake success |
| Diagnostic flood | Fixed reason cardinality/memory cap, không content/secret leaks |

## GREEN — steps

1. Viết decoder trước. Enumerate consumers SDK/worker/recovery/business/UI theo `rg zaloAccountDirectMessageSchema` và `rg zaloAccountGroupMessageSchema`, cập nhật type/tests cùng phase, không chỉ live receive path.
2. Trước JSON.parse/spread: params/ext strings<=16KiB, content string<=64KiB, allowlisted selected record<=256KiB, nested depth<=4, keys<=64/object và existing array caps. Check length/type trước parse; traversal early-stop, không stringify entire raw object để đo size. Callback tại zca-client phải no-throw: catch normalization lỗi thành fixed sanitized reason. Dùng safeParse cả direct/group; validate ID/time, giữ client IDs là observed. Không String(object)/JSON.stringify raw content để hiển thị.
3. Supported content đi existing path. Unsupported dùng stable source và marker, không nhét câu “unsupported” vào text khách để AI đọc.
4. Direct persistence/realtime đi existing Message service, guard placeholder trước reply/contact-input automation. Nếu current pipeline chưa có seam phù hợp, thêm narrow optional Zalo marker guard, không đổi default incoming behavior.
5. Group giữ account/group policy epochs và receive flags; bypass onMessage automation cho placeholder. Không tạo member Contacts.
6. Replace no-op bằng fixed reason counters <=16 keys/process; aggregate pino tối đa một flush/60s. Metadata diagnostic <=2KiB; IDs length capped, không raw text/URL/auth. Không key counter theo UID hoặc arbitrary msgType. Counts là occurrences, không cam kết exactly-once.
7. Publish failure giữ cùng event identity cho retry <=2 lần trong tổng2s. Dùng existing serialized event queue, bổ sung hard pending-byte/count cap toàn process và mỗi account và observable saturation, không thêm in-memory backlog song song. Không log ACK thành công nếu publisher fail. Nếu producer không có replay thì không hứa zero-loss qua process death; ghi residual failure trong staging gate.
8. Render localized label theo reason; no raw JSON. Public list/get trả safe marker giống UI. Không thay globally contentTypes enum chỉ để thêm placeholder.

## Refactor / Tests After

Một helper evidence/parser dùng cho DM/group UI, không framework đa kênh. Giữ existing bounds text20,000/attachments10/mentions100; overflow có explicit reason. Tests dùng sentinel secrets/body/URL để assert không rò vào log/API. Placeholder không tạo provider call hoặc media download.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-transport.test.ts __tests__/zalo-account-group-message.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-message.test.ts __tests__/zalo-account-runtime.test.ts __tests__/fenced-event-publisher.test.ts __tests__/message-integrity-gate.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run __tests__/message.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts __tests__/integration-worker-incoming-message.test.ts __tests__/zalo-account-thread-event.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-group-inbox.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run src/features/messages/components/__tests__/zalo-account-group-message.test.tsx __tests__/zalo-account-message-evidence.test.tsx
```

Create tests mới `apps/builder/__tests__/zalo-account-message-evidence.test.tsx` và `apps/zalo-account-gateway/__tests__/message-integrity-gate.test.ts` trước implementation. Gate test inject env/options và parse actual published frame bằng legacy strict fixture; oversized/nested params/no-throw cases ở provider-message tests. Public-read assertions extend `apps/builder/__tests__/zalo-accounts-public-api.test.ts` hoặc suite messages public hiện hữu đã xác minh, không invent endpoint. Đã xác minh `apps/worker/__tests__/integration-worker-incoming-message.test.ts` hiện có; extend cùng guard cases.

## Acceptance / tasks

- [x] RED có failure evidence, tất cả GREEN sau phase.
- [x] Placeholder DM/group non-empty UI và safe public read, i18n đầy đủ.
- [x] Không automation/provider call/download do placeholder, không fake identity.
- [x] Legacy/new/unknown schemas và reader-first/rollback được test.
- [x] Diagnostic/publish-error memory, count, bytes, rate đều bounded.

## Risks / rollback

- Gateway chết trước Redis publish không tự có provider replay; không tuyên bố durable raw ingress đã tồn tại. Zero-loss qua process death là yêu cầu mới cần chốt riêng, không thêm broker âm thầm.
- Cap mới chỉ cho account message/evidence callbacks, không QR/authorization/lease renewal/stop lifecycle. Cap pending callbacks: <=20/account và <=1MiB/account; khi đầy, safe diagnostic saturation và readiness unavailable qua existing health seam; không auto stop/relogin socket hoặc tạo unlimited timers. Fault test chứng minh không cross-account starvation; tài khoản không có backlog không cấp buffer.
- Rollback tắt writer trước, drain jobs mới, giữ tolerant readers cho JSON đã lưu; không rollback old strict reader khi queue còn evidence mới. Không backfill toàn lịch sử ở phase này.

## Execution evidence — 2026-11-23

Offline implementation/contract tests đã chạy; xem [implementation report](./reports/implementation.md). Không coi automated contract proof là live rollback/provider proof.
