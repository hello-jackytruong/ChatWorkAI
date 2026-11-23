---
title: "P0.1 Zalo account connection/socket/session TDD"
description: "Khóa lifecycle socket Zalo, QR/session fencing, status an toàn và recovery bounded bằng TDD."
status: in-progress
priority: P0
effort: "24-32h (ước tính, chưa phải cam kết provider)"
branch: feat/zalo-account-socket-session
tags: [zalo, connection, socket, session, tdd, status, realtime]
created: 2026-11-23
---

# P0.1 — Zalo account connection/socket/session

## Kết quả và ranh giới

Deliverable là một thay đổi additive, Zalo-specific: `connected` chỉ được phát
sau SDK `connected/open`, một socket attempt có fence/sequence riêng, QR/login
được hủy và dọn dẹp bounded, reconnect phân biệt network với auth evidence, và
status/realtime/UI có projection an toàn. `Connection.status` vẫn là durable
truth; gateway lease chỉ nói gateway còn giữ ownership; socket-open là một fact
khác. Giữ `operations.runtime` legacy, thêm latest `operations.diagnostics` và Redis sample có TTL;
không thêm bảng/migration, service/worker/queue mới, global connection enum,
media/history/recall hoặc SDK bump.

Mọi timeout, retry, TTL, page/deadline, cache TTL và test-count trong các phase
là proposed defaults để implementation điều chỉnh qua test; chúng không phải
giới hạn của Zalo. Không ghi log raw Error/provider URL/cookie/IMEI/user-agent,
không đưa auth/fence/lease owner vào API/realtime. Abort login chỉ được chấp
nhận nếu test chứng minh `Options.polyfill` truyền signal tới request thật; nếu
không, live rollout bị chặn, không dùng `Promise.race` để bỏ mặc network.

## Phases và dependency

Trạng thái thực thi nằm trong frontmatter/task boxes của từng phase; tổng hợp bằng chứng và giới hạn ở [final verification](./reports/final-verification.md). Phase1–3 đã hoàn thành implementation; Phase4 đang kiểm chứng, chưa có live rollout.

| # | Phase | Phụ thuộc |
|---|---|---|
|1|[Contracts và characterization](./phase-01-start.md)|scope/evidence/research reports|
|2|[Socket runtime và session](./phase-02-socket-runtime-and-session.md)|Phase1|
|3|[Safe status API và UI](./phase-03-safe-status-api-and-ui.md)|Phase1–2|
|4|[Regression và rollout](./phase-04-regression-and-rollout.md)|Phase1–3|

## Acceptance gate

Các mục đã tick là implementation và bằng chứng tự động. Full coverage/live release gate cuối vẫn mở; chưa chứng nhận production.

- [x] 17 checklist rows P0.1 đều có test/phase/expected assertion trong
  [TDD matrix](./reports/tdd-test-matrix.md); không có row ngoài phạm vi.
- [x] Socket lifecycle chỉ có một quyết định close cho mỗi attempt; callback
  cũ bị loại ngay cả khi runtime epoch/fence không đổi; tối đa một login in-flight,
  một reconnect timer/account và một lease-renew interval.
- [x] 1000/1006/3000/3003 và unknown error có policy riêng; network/timeout
  không tự đẩy QR; auth chỉ kết luận từ explicit provider rejection hoặc UID
  mismatch. 3003 là kick evidence/hold cần can thiệp, không tự kết luận revoked.
- [x] QR generated/scanned(waiting confirmation)/declined/expired/cancelled
  được terminalize đúng ConnectSession; late login/API được stop, không ghi auth.
- [x] Startup Redis/gateway recovery dùng page/deadline/continuation bounded,
  server/consumer không chờ account chậm; không revive paused/needs_reauth/
  disconnected/manual và không full scan vô hạn.
- [x] Status giữ nguyên fields legacy, thêm runtime snapshot optional/null khi
  unknown/mixed rollout; chỉ allowlist code/reason, không secrets/raw errors.
  Status-only superAdmin hook không gọi groups mỗi 30s; full operations/groups
  contract vẫn tồn tại.
- [x] Realtime mới chỉ `{accountId}`, workspace-only và guest-excluded; event
  chỉ phát sau fence transaction accepted, UI chỉ invalidate query được phép.
- [ ] Full verification/coverage và live release gates theo [final verification](./reports/final-verification.md); không stage/commit/deploy. Các test implementation đã chạy, không dùng99 baseline tests làm bằng chứng behavior mới.

## Tài liệu

- [Design contract](./reports/design-contract.md) — data-flow, invariants,
  budgets, dependency, rollback và unresolved proof gates.
- [TDD test matrix](./reports/tdd-test-matrix.md) — 17 checklist rows, test
  scenario, assertion, owner và command.
- [Scope contract](./reports/scope-contract.md) và [evidence inventory](./reports/evidence-inventory.md)
  — nguồn yêu cầu/evidence đã kiểm tra.

Planning validation lịch sử: [Validation](./reports/validation.md). Implementation đã được người dùng chấp thuận; bằng chứng mới tại [final verification](./reports/final-verification.md), không thay thế bằng báo cáo nghiên cứu ban đầu.
