---
title: "Phase 3: Inbox, regression, security và rollout"
status: todo
priority: P0
effort: "2–3 ngày"
---

# Phase 3: Inbox, regression, security và rollout

## Context và outcome

Phụ thuộc [phase 1](phase-01-start.md) và [phase 2](phase-02-native-operations-and-original-api.md) GREEN. Đọc [scope R01–R16](reports/scope-and-decisions.md), [API/UI evidence](reports/api-ui-research.md), [TDD/resource matrix T15/T28–T32](reports/tdd-and-resource-matrix.md), builder-ui-i18n, security-review, testing-workflow và cli-mcp-docs skills. Phase này giao R05/R06/R07/R14 UI đầy đủ và kiểm hồi quy toàn bộ scope; không thêm capability ngoài P0 · 3. API đã có trước UI, UI gọi cùng services qua authorized actions/query.

## UX và cache protocol

1. ZA recalled bubble và sidebar preview: **“Đã thu hồi trên Zalo”**, giữ chỗ đúng timeline; local hide: **“Đã ẩn trong ChatbotX”**; provider delete-only-me: label mô tả xóa phía mình trên Zalo, không giả thu hồi. Pending/failed/unknown native rõ ràng, không optimistic stamp recalled hoặc reuse generic comment delete. Reply vẫn là tin riêng; chỉ quote preview của target recalled đổi thành safe recalled marker.
2. Action **“Xem nội dung đã lưu”** mở dialog fetch original on demand sau authorization; không lấy original từ list/global store. Hiển thị text/file đã lưu, provider time nullable và observed time riêng, actor unknown nếu thiếu, placeholder/notCaptured/unavailable state; không bịa empty original. Attachment chọn download gọi scoped URL API riêng; saved renderer chỉ authorized URL, không fallback provider/originPath. Không per-bubble HEAD/fetch/poll.
3. Own-message recall chỉ hiện khi complete server capability/ref metadata cho phép; server vẫn kiểm lại. Menu distinct hide local, delete phía mình trên Zalo, recall; conversation clear cần boundary message cụ thể và confirmation mô tả phía mình + phạm vi lùi đến boundary, CRM history giữ lại. Native gate off/unsupported có disabled/unavailable reason; không ẩn implementation thiếu phía sau gate.
4. New saved-content query key full workspace/account/conversation/messageId/createdAt; `staleTime:0`, no persistence, retry false cho denial, `gcTime:0` hoặc remove query khi close. Close/dialog unmount, conversation/workspace/account change và ACL loss phải clear original state+cancel/remove query. Download URL chỉ nằm trong dialog local state, không đưa vào global chat cache. Mở lại phải authorize lại; signed URLs đã trao trước không revoke tức thì, không giả claim memory clear có thể thu hồi bản user đã giữ.
5. Realtime safe lifecycle event patches normal chat state bằng monotone recalled/local-hide marker, scrubs text/translation/attachments/raw nested payload của target, scrubs quote previews ở **loaded visible messages** trỏ target; không delete reply body hoặc `deletedAt` reply. Batch invalidate existing ZA state query + exact saved-content query. Late page/messageCreated/messageContentUpdated/echo không overwrite recalled fence; merge safe projection, message ID+createdAt scoped. Không scan/update toàn bộ history trong DB hoặc all conversations trên client.
6. TanStack mutations invalidate existing message/conversation/ZA state keys trước navigation; không chỉ router.refresh. Same denied/error states public và private; no new global role. Mọi user-facing string qua i18n, kiểm fields keys trước; bổ sung đủ 21 locale files existing, không hardcode Vietnamese-only UI.

## File inventory (absolute paths)

| Action | File | Nội dung |
|---|---|---|
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/messages/components/zalo-account-saved-content-dialog.tsx` | Authorized dialog + saved-only media renderer |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/messages/components/zalo-account-message-actions.tsx` | Distinct message actions/confirmation |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/queries/use-saved-message-content.ts` | Scoped ephemeral query |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/messages/components/message-item.tsx` | ZA bubble/placeholder/actions mount |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/conversations/conversation-action.tsx` | Mount scoped deleteChat boundary dialog |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/messages/message-list.tsx` | No generic optimistic provider deletion |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/chat/chat-realtime.tsx` | Safe marker + bounded invalidation |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/chat/store/chat-store.ts` | Monotone merge and loaded quote scrubbing |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/conversations/queries/resolve-last-message-preview.ts` | Distinct safe labels |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/components/zalo-account-delete-chat-dialog.tsx` | Exact boundary confirmation, mounted from existing Inbox conversation menu |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/messages/en.json` | Canonical keys |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/messages/{ar,az,da,de,es,fi,fr,he,id,it,ja,nl,pt-BR,pt-PT,ro,sv,tr,vi,zh-CN,zh-TW}.json` | Enumerate existing 20 siblings before edit; i18n parity, no locale creation |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/docs/zalo-account.md` | State/API/retention/ACL/media limitation/native gate/ops rollback |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/docs/zalo-account-checklist.md` | Mục 3 evidence only when implemented+verified; mục 2 remains separate |
| Modify when generated contract changes require | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/public-spec-operations.test.ts` | Reviewed spec expectations |
| Modify when required by cli-mcp-docs | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/cli/__tests__/openapi-loader-command-names.test.ts` | Dynamic command collision coverage |

Mount từ existing `conversation-action.tsx`; không tạo alternate menu/page. Pure UI existing markup should stay channel-conditional. No source files edited by this plan.

## Tests Before / RED

| Test (absolute path) | Action | Behavior |
|---|---|---|
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-recall-ui.test.tsx` | Create | R05/R14 labels, placeholder, no original before click/ACL success, distinct local/provider state, actor/time unknown |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-saved-content-dialog.test.tsx` | Create | ACL denial, notCaptured/unavailable, stored-only file, close/change clears cache, reopen reauthorize |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-native-actions-ui.test.tsx` | Create | Gate off, own restriction, boundary confirmation, pending/unknown not success, invalidation |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/chat-store.test.ts` | Modify | Recall scrubs target/quote originals, late page/echo cannot restore, reply body and nonZA stay unchanged |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/resolve-last-message-preview.test.ts` | Modify | ZA recalled label/metadata before generic deleted label; other channel characterization |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/message-item-attachments.test.tsx` | Modify | Marked ZA no URL/filename/provider fallback in ordinary bubble |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/delete-message-action.test.ts` | Modify | Generic ZA delete still rejected; existing channels unchanged |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/member-scope-access-check.test.ts` | Modify | Unassign/team/access loss original read denied |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-recall-regression.test.ts` | Create | End-to-end service/API/projection/merge contract fixtures including nonZA and quote leak |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-group-recovery.test.ts` | Modify | Late group original/crash publishes recalled safe state once, no automation |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/purge-zalo-message-state.test.ts` | Modify | 90d receipt/reaction purge unchanged, recall originals not TTL-purged |

Use existing RTL/fresh QueryClient per test; assert rendered/user outcomes and actual invalidation, no implementation-mirror snapshots only. Characterize normal ZA/nonZA fixtures first; do not weaken generic delete expected cascade. Compare serialized payloads for original sentinel strings/provider URLs/object keys in list/detail/realtime/quotes, rather than only invisible DOM text.

## GREEN và Refactor

- [x] Implement dedicated ZA actions/dialog and conversation boundary confirmation using phase-2 API; no duplicate service business logic.
- [x] Implement server/client monotone lifecycle projection and bounded quote-target batch extraction; preserve reply body and existing nonZA cache semantics.
- [x] Add complete i18n keys, accessibility dialog focus/error/loading/download states.
- [x] Refactor only repetitive ZA rendering/query keys, retain generic comment/message components behavior.
- [x] Update smallest owning docs after implementation evidence, include P0 · 2 dependency/unavailable, receipt/reaction 90d vs original lifetime, best-effort link-issued audit, exact native gate and rollback route.

## Tests After và final gate

Focused RED/GREEN first, then final gate **lint → touched types sequential → affected suites → coverage**. Commands proposed; none run during plan. One command at a time, no dev watcher/build daemon needed.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-account-recall-ui.test.tsx __tests__/zalo-account-saved-content-dialog.test.tsx __tests__/zalo-account-native-actions-ui.test.tsx
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/chat-store.test.ts __tests__/resolve-last-message-preview.test.ts __tests__/message-item-attachments.test.tsx __tests__/delete-message-action.test.ts __tests__/member-scope-access-check.test.ts __tests__/zalo-account-recall-regression.test.ts
pnpm --filter builder i18n:check
pnpm lint
pnpm --filter @chatbotx.io/database check-types
pnpm --filter @chatbotx.io/business check-types
pnpm --filter @chatbotx.io/sdk check-types
pnpm --filter worker check-types
pnpm --filter zalo-account-gateway check-types
pnpm --filter builder check-types
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter chatbotx exec vitest run __tests__/openapi-loader-command-names.test.ts
```

Sau suites, **từng workspace một** database/business/sdk/worker/gateway/builder chạy `VITEST_MAX_WORKERS=1 pnpm --filter <exact-name-above> exec vitest run --coverage`. Threshold 80% existing giữ nguyên, không `VITEST_SKIP_COVERAGE_THRESHOLDS`; missing instrumentation/threshold fail phải báo, không tuyên bố done. Không bare turbo types/concurrent package tsc; cold machine dùng `pnpm check-types:cold` nếu cần full graph. DB integration opt-in phase 1–2 chạy từng file sau explicit approved migration/test DB setup; không chạy migrate hoặc migrate-shards tự động. Không require full build vô cớ; Edge graph/spec tests đủ targeted checks, thêm build chỉ nếu real concern còn lại.

## Security review, rollout và rollback

- [x] Run security-review + invariant-guard (read-only review), sửa real findings theo scoped threat model; review public/private ACL cùng service, `inbox` scope/read_only/expiry/scheduled deletion, raw DTO/quote/realtime/media bypass, token/secret projection, exact idempotent gateway CAS after Redis TTL, audit sanitization.
- [ ] Run cli-mcp-docs cuối thay đổi public contract; `/api/public-spec.json` đủ operations, unique operationIds, machine outputs, GET/POST/destructive annotations. CLI/MCP dynamic consumers không cần duplicate wrapper.
- [ ] Approve additive migration SQL separately trước apply; no shard schema rewrite, no Message/body backfill. Deploy schema → safe server projections/API/lifecycle/repair → UI, native gate vẫn off. Không enable ingestion retention trước safe readers tương thích đã deployed.
- [ ] Controlled disposable DM/group proof phase 2 hoàn thành, source pin+sanitized evidence recorded. Khi bật native theo account/environment pilot, kiểm actual outcomes/status/echo; failure closes gate, không retries destructive unknown. Không dùng production customer thread làm probe.
- [ ] Smoke checklist: original→undo, undo→existing-anchor placeholder→same original, undo→unknown anchor→first message, own echo, reply quote, group recovery restart, attachment stored/unavailable, unassign, gate off/on, same command retry, boundary new-message race, generic other-channel delete. Reuse existing authorized instance; không start duplicate server/port.
- [ ] Observe existing logs/metrics: indexed pending age/count, cursor progress, sanitized error codes, unknown native count, projection misses và access denial; không high-cardinality body/URL logs, dashboard/daemon mới.
- [ ] Rollback: gate native off first; keep safe projection/reader and durable tables, pause new native dispatch, repair pending projection bounded. Không rollback reader về bản raw original leak; data migration rollback destructive không tự chạy. Explicit purge tiếp tục thắng và receipt/reaction purger giữ cap 90d.

Coordination: trước implementation kiểm tra sibling plans P0 media/socket/integrity và reconcile ownership metadata/received-message/recovery seams; không sửa kế hoạch khác hoặc chờ chúng để review text/file **đã lưu**. Nếu seam incompatible, sửa plan này dựa evidence rồi mới code, không generalize identity/sendattempt schemas. Không gọi mục 3 complete nếu còn missing gate; checklist chỉ tick mục nào có implementation/test/live evidence tương ứng. Tất cả checkbox hiện pending.

## Bản đồ R01–R16

R01/R13: exact target + reply characterization (phase 1, UI quote checks phase 3). R02/R12/R14: group/direct tombstone, same-tuple placeholder và race/recovery (phase 1), notCaptured bubble (phase 3). R03: distinct state ledger (phase 1), hide/native API (phase 2), labels/actions (phase 3). R04/R08/R09/R10/R15: retained data, provenance, tracking90d, no recall purge (phase 1; regression phase 3). R05: recalled bubble/preview (phase 3). R06/R07/R11: authorized original/media, projection, audit link-issued (phase 2; UI/cache/security phase 3). R16: all3 native operations, durable dedupe/live proof gate/public API (phase 2), UI/spec/rollout (phase 3). Chi tiết RED/GREEN T01–T32 ở resource matrix; không mục nào được cắt.
