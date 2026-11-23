# Runtime, SDK and worker finish evidence

Date: 2026-11-23. Scope: existing Zalo Account gateway, SDK Zalo wire contract and worker Zalo event handler. No migration, commit, push, deploy, SDK upgrade, new service/queue or other-channel behavior change.

## Completed behavior

- Confirmed and repaired passive-disconnect cleanup failure: a rejected physical-close wait previously left the runtime active/connected with renewal running because the ordered callback tail absorbed the rejection. New regressions first failed on `active: true` instead of `false` (two cases: hold storage succeeds/fails).
- On that failure the existing hold path attempts a durable `held`/`unknown`/`requiresAction` snapshot before teardown. Whether persistence succeeds or fails, teardown invalidates callbacks and stops renewal; an unconfirmed socket remains an unsettled pool tombstone. Reconnect and stop acknowledgement reject while close is unconfirmed; no replacement or lease release is admitted. A later confirmed cleanup can settle/release normally.
- Existing adapter now marks socket started only after SDK `start` succeeds. Added a characterization proving thrown start settles cleanup immediately with no phantom physical-close timer.
- Added worker negative assertions for changed workspace/session route, epoch, fence, event ID, and added attempt/sequence against a legacy encrypted envelope. All reject before decryption or QR/authorization effects. Existing SDK helper additionally binds new secret events to full attempt/sequence and remains compatible with canonical legacy AAD.
- Applied scoped Biome formatting to gateway and SDK/worker owned Zalo files; no unrelated source edited.

## Exact verification

- RED: `VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/zalo-account-runtime.test.ts` — 2 failed / 21 passed before the passive-close repair, both proving the runtime incorrectly stayed active/connected.
- GREEN final full gateway: `VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run` — **18 files, 91 tests passed**. Includes pinned-SDK HTTP cancellation, cookie mutation, physical-close acknowledgement, lease stalls/expiry, bounded auth starts, retry/holds, callback fencing, recovery and terminal pool pruning.
- SDK: `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-transport.test.ts __tests__/zalo-account-group-message.test.ts __tests__/zalo-account-diagnostics.test.ts __tests__/zalo-account-runtime-order.test.ts` — **5 files, 40 tests passed**.
- Worker: `VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts` — **19 tests passed**.
- Scoped Biome: `pnpm exec biome check apps/zalo-account-gateway packages/sdk/src/lib/zalo-account.ts packages/sdk/__tests__/zalo-account*.test.ts apps/worker/src/events/zalo-account/handler.ts apps/worker/__tests__/zalo-account-events.test.ts` — **48 files passed**.
- No typecheck/build/coverage run in this subtask: controller owns sequential type gates and final coverage to avoid concurrent RAM pressure. Full repo lint and remaining cross-module verification are controller gates, not claimed here.

## Limits and live gates

No real Zalo account/provider login or network physical-close trial was run. Pinned SDK factory/fake HTTP tests prove cancellation and cookie serialization/mutation locally; live QR approve/decline/expiry, duplicate/kick behavior, cookie renewal and Redis/gateway restart still require authorized staging execution. A network partition cannot guarantee the old physical socket disappeared. Local tombstones and event/send fencing remain fail-closed; a successfully stored hold also blocks recovery after restart. If durable hold storage itself is unavailable, the process cannot claim restart-durable persistence and does not report successful cleanup.

## Final-review follow-up: automatic retry diagnostics

Reviewer identified that the automatic attempt's connecting diagnostic publish preceded the login try/catch and watchdog. A single rejected stream append or sampled snapshot write could escape the detached retry, leaving active/reconnecting ownership without a provider login or next retry. Two new tests observed RED (`reconnecting` where `backoff` was required). Moved client creation, diagnostic publication and watchdog setup into the existing login error boundary; the existing bounded passive retry policy now handles either transient diagnostic rejection. Tests assert that no provider call occurs on the failed attempt, a later scheduled attempt connects, and stop clears timers.

- Focused runtime: **25 tests passed**.
- Full gateway: **18 files, 93 tests passed**.
- Scoped Biome for the two changed runtime files: **passed**.
- No types, build or coverage rerun in this follow-up; controller owns those sequential gates.
