---
title: "Phase 1: Contracts và characterization"
status: completed
phase: 1
priority: P0
effort: "4-5h"
dependencies: []
---

# Phase 1 — Contracts và characterization

## Mục tiêu và dependency

Khóa các contract additive trước khi đụng lifecycle: SDK/transport phải mang
được `socketAttempt` + `sequence` (optional để đọc event cũ), adapter phải
truyền `connected`, `disconnected`, `closed(code, reason)` và `error`, QR
declined phải có đường abort, còn mọi secret vẫn đi bằng encrypted event nội bộ.
Phase này phụ thuộc [scope contract](./reports/scope-contract.md),
[evidence inventory](./reports/evidence-inventory.md),
[runtime research](./reports/runtime-research.md) và [status research](./reports/status-research.md).
Không thay đổi Connection enum, DB schema/migration, UI, retry policy hoặc
provider behavior ở phase này.

Evidence đã kiểm tra: SDK listener có bốn event lifecycle và close codes
1000/1006/3000/3003 (`../../apps/zalo-account-gateway/node_modules/zca-js/dist/apis/listen.d.ts:19-46`),
adapter hiện chỉ map `closed` và làm rơi code (`../../apps/zalo-account-gateway/src/runtime/zca-client.ts:67-186`),
runtime order hiện chỉ fence/epoch/time/rank (`../../packages/sdk/src/lib/zalo-account.ts:161-187`),
transport base hiện không có sequence (`../../packages/sdk/src/lib/zalo-account.ts:711-718`).
SDK QR declaration đã có `QRCodeDeclined` và `actions.abort`
(`../../apps/zalo-account-gateway/node_modules/zca-js/dist/apis/loginQR.d.ts:3-61`),
nhưng adapter hiện bỏ qua declined (`../../apps/zalo-account-gateway/src/runtime/zca-client.ts:299-331`).

## Requirements / invariants

1. Thêm optional `socketAttempt` và `sequence` vào Zalo lifecycle/runtime order
   và transport envelope/event; event mới có metadata thì comparator dùng
   `fenceToken → epoch → socketAttempt → sequence`. Nếu một/both event thiếu
   metadata (mixed rollout/old row), giữ nguyên fallback `occurredAt → state-rank`;
   không làm event cũ bị reject chỉ vì thiếu field. Fallback chỉ cập nhật legacy lifecycle order; không cho thiếu metadata ghi đè diagnostics đầy đủ trong cùng fence/epoch. `runtime_diagnostic` có order riêng, không thêm connecting/backoff vào legacy state union.
2. `socketAttempt` tăng mỗi lần tạo login/listener attempt trong một runtime;
   closure của callback phải giữ attempt đó. Đây là fence callback, khác gateway
   lease và khác runtime epoch; không expose nó trong public status.
3. Mở rộng port nội bộ cho `onConnected`, `onDisconnected(code, safeReason)`,
   `onClosed(code, safeReason)`, `onError(safeCategory)` và stop trực tiếp.
   `reason` được allowlist/cap trước khi qua runtime; raw provider reason chỉ
   được giữ trong bộ nhớ nếu cần quyết định, không log/publish.
4. Map SDK QR `QRCodeDeclined` thành `declined`; callback phải gọi `abort`
   đúng một lần khi declined/cancel/terminal. `qr_scanned` tiếp tục là trạng
   thái waiting confirmation của ConnectSession; không tự thêm global QR enum.
5. Secret event (`authorization_obtained`, QR ciphertext) giữ encrypted
   transport/AAD; schema lifecycle thường không nhận `auth`, cookie, IMEI,
   user-agent, context, lease owner hay provider exception.
6. Không đổi `zca-js` version, không bật SDK `retryOnClose`, không thêm
   `keepAlive` polling và không tạo supervisor service mới. Các default timeout
   và count sẽ được phase 2 chốt bằng test, ghi rõ là proposed.

## File inventory (absolute; proposed)

**Modify — existing:**

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/src/lib/zalo-account.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/__tests__/zalo-account.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/__tests__/zalo-account-runtime-order.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/__tests__/zalo-account-transport.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/ports.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zca-client.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/fenced-event-publisher.test.ts`
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zalo-account-runtime.test.ts`

**Create — proposed:**

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zca-client.test.ts`

Các fixtures `main.ts` disabled sink và `zalo-account-pool.test.ts` được cập nhật tối thiểu nếu port required thay đổi; không tạo abstraction chung. Xem danh sách caller trong design contract.

## TDD sequence

1. **Baseline GREEN, sau đó RED cho behavior mới:** giữ characterization SDK chứng minh event
   cũ vẫn parse, lifecycle không chứa secret, comparator hiện reject lower
   fence/epoch và same-time state-rank; test adapter double phát đủ numeric
   close codes, connected/disconnected/closed/error, QR declined/abort; test
   publisher giữ AAD/encryption và không serialize cookie. Characterization hiện hữu phải xanh; chỉ test behavior mới phải RED vì port/schema hiện thiếu callback/field, không vì đổi expected legacy.
2. **GREEN — contract nhỏ nhất:** thêm union/schema/optional fields, adapter
   map event và direct stop, publisher copy metadata vào envelope/AAD; thêm đúng schema strict cho `runtime_diagnostic` ở cả lifecycle port và transport payload. Consumer mới phải parse được trước khi producer phát metadata/type mới. Giữ
   fallback cho old event; chưa đổi thời điểm runtime publish `connected`.
3. **REFACTOR — boundary review:** gom safe close/error classifier một chỗ,
   loại listener registration trùng, bảo đảm field names không trùng generic
   realtime/Connection; kiểm tra mọi fake `RuntimeEventSink`, pool fixture,
   disabled sink và default handler compile theo port mới.
4. **RED sau refactor / GREEN lại:** thêm race assertions cho hai callback
   cùng attempt và event thiếu metadata mixed rollout; chỉ merge khi contract
   tests, existing gateway tests và SDK tests cùng xanh. Failure của abort thật
   phải được ghi `[GATING]`, không đổi thành Promise.race.

## Tests Before / Refactor / Tests After

**Tests Before (lệnh tương lai, không chạy trong lúc lập plan):**

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-runtime-order.test.ts __tests__/zalo-account-transport.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts __tests__/fenced-event-publisher.test.ts
```

**Refactor/check:**

```bash
pnpm --filter @chatbotx.io/sdk check-types
pnpm --filter zalo-account-gateway check-types
```

**Tests After (lệnh tương lai):**

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-runtime-order.test.ts __tests__/zalo-account-transport.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zca-client.test.ts __tests__/zalo-account-runtime.test.ts __tests__/fenced-event-publisher.test.ts
```

## Scenario matrix

| Scenario | Expected assertion |
|---|---|
| Event có `socketAttempt=2, sequence=4` sau attempt 1 | Schema nhận; order mới thắng khi fence/epoch bằng nhau. |
| Event cũ không có metadata | Comparator dùng timestamp/state-rank như hiện tại; không throw. |
| Lower fence nhưng sequence lớn | Bị reject; sequence không vượt lease fence. |
| Same runtime, attempt 1 callback sau attempt 2 | Port giữ attempt identity; callback có thể bị runtime phase 2 loại, không làm contract mất identity. |
| SDK emits connected/disconnected/closed/error | Adapter truyền đúng code/category, không đổi raw reason thành public data. |
| Close codes 1000/1006/3000/3003/unknown | Normalizer trả nhóm allowlist ổn định, không log URL/cookie. |
| QRCodeDeclined | `ZcaQrEvent` là `declined`, action.abort được gọi tối đa một lần. |
| QR callback chứa GotLoginInfo sau abort | Adapter có thể chuyển event nội bộ; runtime phase 2 sẽ fence/stop, schema không làm rò auth. |
| Secret event | Ciphertext/AAD vẫn encrypted; lifecycle payload không có auth fields. |
| Disabled sink/default fake | Mọi method mới có no-op typed sink; không làm crash startup. |

## Acceptance, security và resource budget

- Contract compile được ở SDK/gateway; test xác minh old event parse và new event
  reject malformed sequence/attempt, secret leakage, AAD mismatch.
- Không có raw provider error trong assertion/log fixture; mọi helper chỉ trả
  safe category/code. `zca-js` 2.1.2 và `node_modules` chỉ là evidence, không
  phải file được sửa.
- Budget phase: không thêm timer, socket, Redis call hay DB write; adapter test
  tối đa một fake listener/client mỗi case; mọi test timeout dưới 1 giây.
- Rollback: dừng producer mới, dùng reader mới drain event có field/type mới trước khi hạ reader; schema transport cũ `.strict()` không chấp nhận event mới. Reader mới phải tiếp tục parse event cũ. Không rollback bằng migration vì không có.

## Dependencies và unchecked tasks

- Blocker trước Phase 2: tên field/shape được chốt trong SDK tests; `zca-client`
  test phải chứng minh SDK listener event thật theo declaration pinned.
- `[UNCHECKED/GATING]` Chưa chứng minh adapter-local `polyfill` abort cancels
  every login request; Phase 2 phải test fake fetch truyền signal. Không có proof
  thì không ship live timeout/abort claim.
- `[UNCHECKED]` Chưa có live Zalo credentials/provider behavior; không dùng
  provider assumption để mở rộng auth classifier.

## Tasks

- [x] Giữ characterization legacy GREEN và ghi đúng nguyên nhân RED của test mới.
- [x] Chốt schema strict cho metadata/order, runtime_diagnostic và secret refresh.
- [x] Cập nhật các caller/fake/disabled sink liệt kê trong design contract.
- [x] Chứng minh adapter open/close/error/QR decline đúng shape pinned SDK.
- [x] Chạy focused tests/types và bàn giao contract sang Phase 2.
