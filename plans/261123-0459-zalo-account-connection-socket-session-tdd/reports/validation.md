# Validation và review — P0 · 1

Ngày: 2026-11-23. Trạng thái implementation: **pending**. Phạm vi: chỉ 17 mục connection/socket/session; không media, thu hồi, history hoặc refactor kênh production khác.

## Evidence và cách xác minh

- Đã đọc README, tài liệu Zalo Account/checklist, pinned SDK2.1.2, source gateway/SDK/worker/business/repository/status/UI/realtime và test manifests. Các anchor hiện trạng nằm tại [evidence inventory](./evidence-inventory.md); có hai báo cáo nghiên cứu độc lập.
- [Runtime research](./runtime-research.md) ghi nhận baseline 99 tests đã pass: gateway21, SDK31, business17, worker9, connections21. Đây là test hiện hữu, **không** phải chứng minh behavior mới hoặc live provider. Không chạy thêm test/build/migration khi rà plan.
- [Security review](./review-security.md) có 10 claims nguồn/interface kiểm chứng và 4 finding. [Failure review](./review-failure.md) có 3 finding nguồn/race. Các report giữ nguyên bối cảnh bản nháp; contract cuối đã thay thiết kế được chỉ ra là thiếu.
- Kiểm tra cơ học: 4 phase, mỗi phase có Tests Before/Refactor/Tests After, ma trận scenario, task checkbox và rollback/resource gates; ma trận nối đủ17 dòng checklist và53 scenario cụ thể. Relative links và proposed/existing file paths được rà riêng.
- `ak plan validate` chỉ kiểm tra cấu trúc plan, không thay thế source/contract review, test hay staging.

## Disposition có bằng chứng

| Nguồn | Finding | Disposition | Thay đổi trong bản cuối |
|---|---|---|---|
| Failure1 | Chưa có awaited abort/physical-close boundary, data callback chỉ generation | Accept | Cancel handle + settlement + owned close listener, admission/execution attempt fence mọi callback; không false applied khi stop timeout. |
| Failure2 | Hold3000/3003 mất khi restart | Accept | Latest durable diagnostics hold theo auth fingerprint, commit-before-release, recovery skip và QR manual-clear; không đổi Connection enum. |
| Failure3 | Recovery không có trigger/cursor/deadline thực thi được | Accept | Startup/Redis-ready/lease-loss coalesced main trigger, một run/timer, per-account cursor advance, page50/30s budget, consumer single-instance. |
| Security1 | Runtime-only auth revision không thấy generic same-UID QR write | Accept, sửa giải pháp | CAS fingerprint ciphertext đang lưu + durable ownership claim trước load secret/login; QR binding chung giữ nguyên. Expected fingerprint nằm trong encrypted body/AAD-bound route, không public. |
| Security2 | SDK recursive QR retry dùng callback cũ | Accept | Fresh client/attempt sau abort+settlement cho pre-scan retry; late same-UID GotLoginInfo bị loại; sau scanned expiry dùng terminal/retry session mới. |
| Security3 | Gán3003 thành expiry không có nguồn | Accept | Chỉ KickConnection/hold; reauth cần explicit auth evidence/UID mismatch. |
| Security4 | Account ID hint tới ordinary member | Accept, làm rõ threat model | Chỉ opaque workspace invalidation ID, không UID/tên/diagnostics; giữ permission action, negative member test và guest exclusion. Không thêm targeted-recipient/roster subsystem chỉ để gửi hint; realtime không cấp quyền. |
| Parent | Lease mới + snapshot connected cũ gây false active | Accept | Redis snapshot phải match current lease và durable order; mismatch/missing/expired trả socket unknown. |
| Parent | lastEvent chỉ lấy lifecycle, thiếu SDK event thực | Accept | Sample SDK events in-memory → lease-fenced Redis≤1/30s, phân biệt lastLifecycleAt; không per-message DB/stream. |
| Parent | Diagnostic payload chưa có wire path riêng với FSM | Accept | type runtime_diagnostic trong lifecycle transport, diagnostics-only apply; operations.runtime legacy giữ nguyên. |
| Parent | Old strict reader reject new optional field/type | Accept | Reader-first deployment; producer-first stop/drain khi rollback, không claim old worker nhận new event. |
| Parent | Focused coverage tính toàn bộ source; check-types lạnh lặp lại | Accept | Focused RED/GREEN không coverage; full affected workspace coverage tuần tự80threshold; bỏ global cold typecheck lặp, thêm database types. |
| Parent | Tác động shared Connection files chưa cần thiết | Accept | Generic device-session-flow/service read-only reference; terminal behavior trong nhánh Zalo gọi existing guards, chỉ sửa helper chung nếu có evidence bắt buộc. |

## Scope/contract review bổ sung

[Scope review](./review-scope.md) có3 finding, đã nhận và xử lý:

- New-test ownership/baseline: chỉ rõ first-create Phase1/2, Tests Before là đầu phase sau dependency GREEN; bổ sung account-lease-store/command-executor test gates. Không tự đổi command result union khi rejection hiện hữu đủ.
- DB concurrency proof: file integration required, race hai connection + scoped cleanup và gate test executed-not-skipped trên disposable DB được phép dùng; không apply migration.
- Aggregate polling: tận dụng cap100 hiện có của settings page, công thức2N DB/N MGET mỗi30s, fake-time testN100, visibility+dedup và một coalescing timer màn hình. Không thêm API batch mới.

Scope reviewer xác nhận coverage và reader-first rollout đã được giải quyết; production integration khác chỉ có regression tests.

## Quyết định không cần phỏng vấn lại

- Yêu cầu đã chốt đầy đủ scope, TDD, tiết kiệm tài nguyên và không ảnh hưởng kênh khác. Không có quyết định nghiệp vụ mới buộc người dùng chọn để hoàn tất bản kế hoạch.
- Review corrections là sửa thiết kế theo source, không cắt 17 mục hoặc thêm P0.2–P0.4. Các giá trị timeout/capacity là proposed defaults và được test trước khi dùng.
- Không coi fail proof về abort/cookie/close là lý do silently bỏ mục; dừng bước phụ thuộc, ghi bằng chứng và sửa trong phạm vi. Không tự nâng SDK/đổi kiến trúc chung.

## Whole-plan consistency sweep

- Đọc lại index, cả4 phase, design contract và matrix sau khi sửa.
- Đồng nhất: diagnostics JSON riêng với legacy runtime order; ciphertext CAS; QR fresh attempts; 3003 không expiry; runtime_diagnostic là lifecycle payload type, không thêm transport kind trùng; last SDK event sample; lease freshness; reader-first rollout và full-workspace coverage.
- Thêm T41–T53 cho các race, permission, resource và rollout gaps từ review; giữ T01–T40 và17 requirement rows.
- Task state nằm trong file checkbox/frontmatter pending và local AgentKit index. Không có session task-manager riêng khả dụng; không tạo GitHub issue, không thay worktree current-plan pointer của các task khác.
- Không stage/commit/deploy hoặc sửa source để tạo kế hoạch này. Các thay đổi đang có của task khác được giữ nguyên.

## Handoff và gate thực thi

Kế hoạch có thể bắt đầu **TDD implementation** khi người dùng yêu cầu. Không phải xác nhận production-ready. Chưa đóng các proof gate: abort tất cả SDK request phases, physical close acknowledgement, cookie serialization/mutation semantics, real QR/close payload và Redis restart staging. Từng gate có test/phase sở hữu; không có unresolved product choice cần hỏi để lập kế hoạch.

Không áp migration tự động; kế hoạch này không yêu cầu tạo migration. Không chạy live account/deploy/merge chỉ vì plan đã được viết.
