# Final verification — Zalo Account connection/socket/session

Date: 2026-11-23. Branch: `feat/zalo-account-socket-session`. Implementation phases1–3 complete; all planned local verification commands finished. Disposition: **DONE_WITH_CONCERNS**; phase4/overall plan remains in progress because verification/release gates are not all green. No migration, staging, commit, push or deployment. Other channel implementations and unrelated changes preserved.

## Behavior evidence against all17 checklist rows

Automated evidence proves the local behavior below. It does not substitute for a live Zalo provider trial. Row numbers follow [the accepted matrix](./tdd-test-matrix.md).

| Rows | Verified automated boundary | Test owner |
|---|---|---|
|1,4| UID before authorization/open; saved login and QR; connected only on SDK open; stop/cancel prevents late attachment |gateway runtime, adapter, connections device-session|
|2| lease before durable claim before provider; fence/epoch/attempt/sequence guards; stale lower fence/sequence cannot mutate |gateway lease/runtime/publisher, SDK order, real PostgreSQL|
|3,7,8,9| bounded jitter/backoff, short-open failure budget; manual close distinct;3000/3003 durable hold; network/unknown never inferred revoked |gateway policy/runtime/pool and DB hold tests|
|5,11| Connection, lease and verified socket separated; exact matching/fresh sample only; safe nullable diagnostics, legacy fields retained |business status, public schema/API, builder status UI|
|6| connected/disconnected/closed/error mapped; one close decision; admitted FIFO preserved and stale callbacks dropped |adapter/runtime|
|10| pinned SDK HTTP signal cancellation and settlement, login/open watchdog, physical-close timeout tombstone, stalled lease renewal deadline, retry publication failure recovered |gateway SDK integration/runtime/resource tests|
|12| last SDK event sampled in memory; quiet fresh socket stays open; bounded Redis snapshot, no per-message diagnostics DB/stream |gateway runtime/lease and business status|
|13| committed accepted events only; accountId-only workspace hint, guest excluded;30s status-only poll, hidden pause,250ms coalescing, max100 mounted IDs, group panel lifecycle |worker/protocol/builder status query/UI|
|14| server/consumer start independent of account login;50-row/30s recovery and cursor continuation; single coalesced restart; durable holds and inactive rows skipped; replay fenced |gateway main/recovery/pool and real PostgreSQL|
|15| pinned SDK cookie mutation; encrypted event AAD binding; identity/active scope/lease/ciphertext CAS; both QR-refresh commit orders |SDK/worker, gateway cookie integration, business and real PostgreSQL|
|16| QR generated/scanned-waiting/declined/expired/cancelled terminal guard; no late auth; dialog closes only completed |adapter/runtime, worker session handler, builder QR UI|
|17| SDK stays in gateway, identity/cookie private; no new keepAlive polling or context endpoint |adapter integration, public resource redaction, invariant/security review|

Detailed RED→GREEN and exact focused commands: [runtime](./runtime-implementation.md), [business/DB](./business-implementation.md), [UI/API](./ui-implementation.md), [other-channel/spec/CLI regressions](./production-regressions.md).

## Review and resources

- Independent invariant/security source review: [PASS](./final-invariants.md), no concrete violation. Public resources use explicit fields; diagnostic keys/holds/fingerprints stay private; secret events are AAD-bound before decryption.
- Final runtime reviewer found automatic retry diagnostic publication escaping its error boundary. Both append and snapshot rejection regressions observed RED; moving setup into the existing retry boundary restored recovery. Full gateway:18files/93tests passed. Reviewer re-read exact repair and cleared finding.
- Real PostgreSQL:11 executed/pass,0 skipped, deterministic two-connection barriers, unique fixture cleanup. Existing Docker dev DB schema reused as user instructed; no migration.
- Status budget per mounted visible account/30s: one request, two targeted DB reads, one two-key MGET; zero provider/group calls. Max100 mounted rows; hidden invalidations mark stale without fetching; group query mounts only open panel. Global auth admission max2; no permit waiter queue. One retry/renew/watchdog per runtime with bounded close cleanup and retained fail-closed tombstone.

## Verification gates

- `pnpm lint`: PASS after final runtime/type fixes,11956 files; agent instructions/invariants, schema drift and locale parity pass.
- Touched-workspace types: **all8 pass**, sequential SDK, realtime-protocol, database, business, connections, worker, gateway, builder. Initial type gate caught missing nullable operations in resource projection; corrected to explicit `operations:null` and rechecked dependents. Builder next-intl generated declaration was stale; regenerated using configured next-intl plugin without server/build, then full builder check passed. Gateway rechecked after final retry repair.
- Focused business38, worker19, builder42, SDK40, gateway93 tests pass. Separate production/public regression:12files/174tests pass. Full business rerun after fixture repair:675files passed,10820tests passed,52files/552tests opt-in skipped; exit0,210.21s. Its earlier coverage invocation had1 fixture assertion failure and did not produce a successful coverage gate; do not present that invocation as green.
- Full builder guard caught the status-only action missing from the API parity manifest. Registered it against existing `covered:zalo-accounts`; parity/public/action tests3files/15tests pass after repair. No public route or production logic change.
- Full affected-workspace coverage: gateway, SDK, database, connections and worker fail existing80% aggregate thresholds; realtime-protocol passes. First business coverage invocation failed its fixture assertion; full plain rerun after repair passes, but no corrected full coverage result is claimed. Builder full run finished with11482pass/1parity-manifest failure/2skips; exact manifest failure repaired and3files/15tests pass afterward. No corrected full coverage invocation is claimed. No threshold bypass or measured baseline comparison; no failure is called preexisting. Skipped opt-in tests are not counted as DB concurrency proof.

Full command results and coverage percentages: [workspace gate table](./workspace-gates.md), [machine records](./gate-results.json).

Local journal: [implementation history](../../journals/2026-11-23-implement-zalo-account-connection-socket-session-with-tdd.md). AgentWiki publish skipped.

## Unperformed live/release gates

- No real Zalo credentials/session used. Need bounded staging QR approve/decline/expiry, UID reconnect, real open/physical-close acknowledgement, duplicate/kick codes and cookie renewal.
- Actual Redis/gateway/worker restart or partition rehearsal and mixed-reader/producer deployment canary were not run. Local fakes and DB races cover logic, not provider/network behavior.
- No builder listens on localhost3123. Live public-spec/CLI refresh-help/MCP tools verification unavailable (curl7/HTTP000); generated spec, MCP catalog and CLI collision tests pass. Existing route/scope/group/default-tool visibility unchanged.
- Compatible readers must deploy before new gateway events. Rollback stops/drains producers and queued new-format events before reader downgrade. Unknown physical close remains held, never acknowledged as stopped.

These gates block a claim of production readiness; deployment is outside this authorization. Keep plan/Phase4 in progress until coverage and live gates are resolved; keep live checklist items open. All started test runners have completed; no app/provider server was started. Docker Postgres was started only for the authorized fixture tests, with no other client sessions observed before cleanup; its stop result is recorded below.

## Cleanup and authorization boundary

- Existing Docker Postgres container started for the authorized real-DB tests was stopped cleanly after all tests; no other client sessions were present before stopping. Fixtures and connections were cleaned; no schema migration.
- All test/lint/type processes started by this task completed. No builder/gateway/provider server was started, and no duplicate dev process was left behind.
- Final root lint rerun after parity-manifest repair passes; diff whitespace and owning docs/report relative links pass. No stage, commit, push, merge or deploy. No production-channel integration implementation or generic Connection enum changed.
