# TDD traceability — P0.4

Ngày 2026-11-23. Ma trận dưới đây giữ thiết kế tests ban đầu. Code đã được triển khai; kết quả thực thi và gate còn mở tại [implementation report](./implementation.md). Các case chưa chạy với DB thật/live không được coi là pass. Hai mục đã checked trong checklist là baseline phải bảo vệ, không viết lại.

## 12 mục checklist → phase → acceptance

| # | Mục | Phase | Case/proof |
|---|---|---|---|
| 1 | Canonical/status hiện hữu | 1,3 | Claim trước dispatch, same command/input, applied terminal |
| 2 | No replay unknown hiện hữu | 1,3,4 | Timeout/ACK failure/duplicate job provider calls=1 |
| 3 | Mọi loại gửi cùng canonical | 1,3 | Inbox/API/flow direct/group text/image/file; future type guard, không thêm sender |
| 4 | Own-echo/multi-ID | 3 | 2 IDs, each echo trước/sau ACK, một canonical khi đủ proof |
| 5 | msgId/cliMsgId/scope/time/type | 2,3 | Preserve exact identity, no unsafe number/peer guess/clientId inference |
| 6 | Trùng/sai thứ tự/đến muộn | 2,3 | Concurrent claims, late ACK, stale CAS, published group rebind, lifecycle aliases |
| 7 | Placeholder | 2 | Valid identity một bubble, missing identity diagnostic only, no automation/download |
| 8 | Metrics invalid/unsupported | 2,4 | Fixed reason cardinality/cap, no raw secret/body; errors visible |
| 9 | Schema/version | 2 | Legacy/v1/unknown, reader-first, safe rollback drain |
| 10 | Rate/retryAfter | 4 | Direct bucket, preserve group60/10, typed delay, no double charge/fail-open |
| 11 | Read retry/write classification | 3,4 | Pure reads<=2, fence check, writes unknown/no replay, repair local-only |
| 12 | Receive/media/send errors | 2,3,4 | Safe error codes/UI inspect, current prep failure, no scope expansion to R2 mirror |

## Fault/interleaving scenarios bắt buộc

- Echo1→echo2→ACK; ACK→echo2→echo1; duplicate ACK; job replay sau completion; two concurrent workers.
- ACK core DB commit→crash trước shard merge; shard merge→crash trước identity rebind; rebind→crash trước CAS complete; complete→realtime failure.
- Late failure sau applied; stale recovery completion sau revision mới; unresolved provider success không có durable proof.
- Same IDs giữa accounts/workspaces/threads; same text/time khác intents; actual phone-app own-echo không thuộc ChatbotX send.
- Primary/secondary receipts/reactions/undo; old group policy epochs; account blocked/deleted.
- Canonical/echo ở shard khác; unknown row timestamp; references/rows vượt budget giữ data + needs_review.
- Placeholder replay/upgrade, unknown schema, malformed nested params, numeric IDs unsafe, emoji/mentions bounds.
- Redis/DB/storage preparation failure, stream capacity, consumer retry expiry, diagnostic flood/readiness signal.

## TDD execution discipline

1. Baseline focused tests trước, lưu kết quả.
2. Viết failing regression cho behavior thật; ghi assertion và nguyên nhân RED, không test chỉ mirror implementation.
3. Sửa tại owner tối thiểu để GREEN; không weaken test/mock away concurrency.
4. Refactor dưới same tests, thêm boundary/negative cases.
5. Lint/types/tests/coverage gates trước ship. Không test source code sau khi vừa tạo plan rồi gọi là verified.

## New tests cần tạo khi thực thi

- `apps/builder/__tests__/zalo-account-message-evidence.test.tsx` — placeholder/outcome/inspect/UI scope.
- `packages/database/__tests__/integration/zalo-account-integrity-recovery.test.ts` — two-client CAS, aliases/shards/references/crash.
- `packages/business/__tests__/zalo-account-send-admission.test.ts` — chỉ khi tạo helper riêng; otherwise extend group service tests.

Các test còn lại extend file có sẵn đã liệt kê từng phase. Không thêm global test harness/fixture DB dùng chung cho mọi channel. Real-provider smoke tách khỏi CI unit tests, chỉ bounded staging với authorization phù hợp.
