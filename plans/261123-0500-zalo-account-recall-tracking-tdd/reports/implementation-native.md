# Native message operations implementation

Status: implemented; integrated verification and controlled provider proof remain rollout gates.

## Behavior

- Added typed native commands for pinned zca-js 2.1.2 undo, deleteMessage and deleteChat. Undo passes the exact provider/global and provider client IDs. DeleteMessage always supplies explicit `onlyMe=true`. DeleteChat supplies the captured owner/client/global backwards boundary and makes no CRM-history mutations.
- Native service resolves the persisted target through the shared retained-message ACL resolver, checks authoritative message metadata, denies missing provider client IDs, rejects nonself recall, and rejects explicitly ambiguous multi-provider targets. The public API never accepts provider references or self ownership claims.
- Public methods: recall, deleteOnZalo, deleteChatOnZalo, getOperation, getCapabilities. The parent owns API/UI wiring and shared exports. Capabilities reauthorize the exact message and apply current native/group availability.
- The shared `ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED` flag uses existing `parseEnvBool`; default and string `false` both disable. Gateway and service both enforce it.
- Commands use the existing account serializer and lease/fence checks. The gateway invokes a durable pending→dispatched main-ledger CAS immediately before calling the SDK, after account/group admission. Native commands never rely on Redis's 24-hour cache as dispatch authority. A second gateway invocation, a Redis-state loss or unknown outcome cannot obtain another dispatch claim.
- Native transport IDs use existing scopedZaloCommandId because Redis result keys are global; the typed payload retains the public attempt command ID separately.
- Confirmed applied handling is a single repository transaction: attempt settlement plus exact recall/providerDelete obligation plus pointer binding. DeleteChat confirmation bypasses all local message lifecycle writes. No database transaction spans the SDK invocation.
- Numeric provider status is not assumed to mean success. The executor supports an explicit status-proof resolver for controlled evidence fixtures; production supplies none, so SDK responses remain unknown. Native gate must remain off until authorized live DM/group proof. No real account calls were made.

## TDD and verification

Tests before implementation failed for missing exact SDK adapter and then for business behavioral assertions against the initial service skeleton. GREEN tests cover exact undo/deleteMessage/deleteChat arguments, complete provider tuple schema, caller override rejection, gate false, missing client refs, nonself recall, immutable boundary, no CRM deleteChat effects, scoped command identity, unknown no redispatch, hash/target conflict, and shared transaction propagation for confirmed recall.

Commands run with VITEST_MAX_WORKERS=1:

- Business native service: 11 tests passed.
- SDK native schema: 2 tests passed.
- Full gateway workspace: 13 files / 64 tests passed.
- Ultracite check: 14 owned source/test files passed.

Parent owns the combined sequential type checks, repository lint, integrated coverage and API/UI suites; no tsc was started here. No migration was applied, no git commit was made, no process or daemon was left running.

## Security review

No unresolved cross-tenant/auth/secret finding identified within this slice. Native message references come from authorized persisted rows and gateway rechecks command payload against the immutable scoped attempt before claiming. Command-ID/hash changes fail before SDK invocation. Public operation results omit raw provider refs and raw provider exceptions. Group policy is checked at service preparation and serialized gateway dispatch.

## Limits

Static SDK signatures and mock tests establish invocation shape, not Zalo success semantics. Missing/ambiguous authoritative provider/client refs remain unavailable rather than synthesized. Real provider status/time-window/ownership restrictions, event echo behavior and backwards boundary semantics require the accepted plan's disposable-account proof. Release should retain the default-off gate until that evidence exists.

## Final review and integrated verification

The final concurrency review found and fixed two concrete gaps with behavioral RED→GREEN tests:

1. A native command could wait behind another account operation after the executor's initial lease/expiry check. Dispatch now rechecks command expiration, current lease ownership and the existing provider circuit breaker inside the serialized `beforeDispatch` callback, immediately before the durable claim. Expired/stale commands never claim or call the SDK.
2. Confirmed group settlement omitted the required group ID from the recall obligation and bypassed the shared target lock. Settlement now sets bounded transaction timeouts, acquires the workspace purge guard then the exact target advisory lock, and only then updates the attempt. It resolves the persisted group binding in the same transaction, includes group ID in the obligation, and does not reapply live group policy after an already-confirmed provider outcome. A workspace already being purged cannot settle or create an obligation.

Sequential checks completed:

- SDK check-types: passed.
- Worker check-types: passed.
- Gateway check-types: passed.
- Business native service after the settlement fix: 13 tests passed.
- SDK full suite with coverage: 19 files / 269 tests passed, but the unchanged 80% global coverage gate failed. Statements 76.87%, branches 62.19%, functions 63.63%, lines 76.99%.
- Gateway full suite with coverage: 13 files / 66 tests passed, but the unchanged 80% global coverage gate failed. Statements 58.27%, branches 54.71%, functions 46.96%, lines 58.55%. The command executor itself reached 87.37% statements/lines, 83% branches and 90% functions.

Coverage was run with `VITEST_SKIP_COVERAGE_THRESHOLDS` removed from the environment, with VITEST_MAX_WORKERS=1. No threshold, include or exclusion was changed. These are actual current-tree global coverage gaps, not a measured comparison against the pre-change branch; broad uncovered boot/runtime/SDK surfaces remain. The two whole-workspace coverage commands therefore exited nonzero despite all tests passing. Parent retains responsibility for recording this incomplete acceptance gate and the final business/builder type pass after integration.
