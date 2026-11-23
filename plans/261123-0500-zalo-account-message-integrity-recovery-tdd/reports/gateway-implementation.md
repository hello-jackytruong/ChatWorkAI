# Gateway implementation evidence

Scope: gateway inbound evidence/writer gate, bounded callback admission and publisher retry; send circuit/read retry; business send capacity and typed transport errors. No socket ownership redesign, database migration, credentials, servers, git staging or provider calls.

## Actual RED before implementation

All commands used `VITEST_MAX_WORKERS=1 pnpm --filter <workspace> exec vitest run <paths>`.

- Gateway `__tests__/message-integrity-gate.test.ts`: 3 failed — valid unsupported identity produced no placeholder, conflicting self UID was not rejected, oversized direct content threw a ZodError.
- Gateway `__tests__/provider-admission.test.ts`: 1 failed / 2 passed — 5,000 account entries exceeded the required 4,096 cap.
- Gateway `__tests__/command-executor.test.ts`: 2 failed / 14 passed — pure read was attempted only once; provider pause blocked stop. A first stop test fixture omitted its required target; corrected fixture was rerun RED on the intended assertion before implementation.
- Gateway `__tests__/zalo-account-runtime.test.ts -t 'bounds pending account'`: failed — saturation readiness missing and no pending callback cap.
- Gateway `__tests__/fenced-event-publisher.test.ts`: 2 failed / 6 passed — schemaVersion leaked into default legacy wire and transient append failure was never retried.
- Business `__tests__/zalo-account-send-admission.test.ts`: 2 failed / 1 passed — direct capacity function missing; group atomic 60/10 baseline passed.
- Business `__tests__/zalo-account-transport.service.test.ts`: 1 failed / 10 passed — structured admission errorInfo was lost in transport.
- Independent review identified identity scalar bounds accidentally affecting long supported text/URLs. Added actual RED separately for 2,000-character text and >1,000-character URLs with the gate on/off (four failures); fixed by separating identity512, text/quote20,000 and URL65,536 bounds. Both targeted suites then passed 19 tests.

## Implementation

- Normalization is no-throw, validates exact/safe numeric identity and own UID consistency, checks bounded object/string/depth/array budgets before parsing/spreading. Unknown/invalid/unsupported content with validated headers can emit a safe marker with no raw body. Default behavior preserves supported legacy messages and drops unsupported traffic.
- `ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED` defaults false, propagates env/main/pool/runtime/client/publisher. Publisher gate off strips schemaVersion and suppresses placeholders; gate on permits new SDK metadata.
- Existing per-runtime serialized event queue reserves <=20 callbacks / 1MiB per runtime, <=200 / 16MiB process-wide for message/evidence callbacks. Lifecycle/QR/lease callbacks do not consume these budgets. Saturation affects readiness, reserves no extra queue or timer, and clears after draining.
- Fixed diagnostics have 11 reason keys, safe counters only, <=2KiB aggregate, at most one flush/60s on subsequent activity. No arbitrary reason, ID, body, URL, stack, or token is retained.
- Message publication retries the identical serialized event at most twice total inside two seconds. Stale fence rejection is never treated as success. No durable raw ingress was added.
- Provider circuit account map caps at 4,096. Expired entries disappear on access; each periodic sweep visits <=64 entries, at most once/30s. New accounts fail closed with a bounded delay when capacity is full.
- Exhaustive command safety classification allows pure reads only (groups/friends/labels) one retry inside the same claim, with original deadline/owner/admission rechecks. Writes never replay; stop bypasses circuit and does not heal it.
- Atomic Redis direct bucket is 60/account/minute, after attachment preparation immediately before provider call; runtime ownership is checked before/after admission. Group atomic 60/account + 10/group remains unchanged and is not charged a direct bucket. Redis failures fail closed with safe errorInfo.
- Preparation and dispatch failure strings are safe fixed messages. SDK errorInfo survives failed gateway outcome -> business transport -> ZaloAccountPreDispatchError; legacy string-only frames remain accepted.

## GREEN / validation

- Final focused gateway matrix (11 files): **87 passed**. Files: provider-message, message-integrity-gate, message-diagnostics, provider-admission, command-executor, fenced-event-publisher, runtime, pool, zca-client, main, redis-command-consumer.
- Final publisher/runtime/client follow-up: 3 files, 40 passed, including a process-wide 200-callback regression and parsing actual published frames with a legacy strict fixture.
- Business transport/admission/group matrix: 3 files, 23 passed.
- `pnpm exec ultracite fix <23 owned changed/new TS paths>`: passed after addressing findings.
- `pnpm --filter zalo-account-gateway check-types`: passed after explicit union narrowing of start_qr at retry ownership check. Final repeat after concurrent cross-module edits exits2 only at outside-owned `packages/business/src/message/service.ts:406` because realtime contentAttributes is nullable but requires Record<string,unknown>; controller notified. No gateway type errors reported.
- Root controller owns repository lint, build, broader regression and coverage gates; these are not claimed from focused tests.

## Files

Gateway source: env.ts; main.ts; runtime/{ports,provider-message,message-diagnostics,zalo-account-pool,zalo-account-runtime,zca-client}.ts; transport/{command-executor,fenced-event-publisher,provider-admission}.ts.
Gateway tests: {command-executor,fenced-event-publisher,main,message-integrity-gate,message-diagnostics,provider-admission,zalo-account-runtime,zca-client}.test.ts.
Business source: zalo-account/{group-rate-limit,transport.service}.ts. Business tests: {zalo-account-send-admission,zalo-account-transport.service}.test.ts. Existing group.service.ts did not need modification: its policy validation already precedes capacity consumption and typing uses consumeCapacity:false.

## Residual / release limitations

- Unit tests do not prove real Redis atomic behavior, provider identifiers, live account replay, or deployment sequencing. No real provider send or DB migration was run.
- A gateway process can die before Redis append and the provider may not replay. Saturation deliberately rejects excess callbacks and reports pressure; readiness/diagnostics do not create durable ingress.
- A timed-out Redis append can finish later; retry uses exactly the same event identity/frame, allowing downstream existing dedupe. It does not repeat a provider send.
- Writer must remain off until all readers understand optional schemaVersion/unsupported. Disable writer and drain newer jobs before an old strict reader rollback.
