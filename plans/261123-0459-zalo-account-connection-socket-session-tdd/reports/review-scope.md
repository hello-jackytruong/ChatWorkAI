# Scope / Contract Review — P0.1

Read-only review of the current plan and its design/TDD reports. No tests,
build, lint, or source edits were run. The review is limited to the requested
socket/connection/session surface and the smallest related status/API blast
radius.

## Findings

### 1. High — test ownership and “before” commands are internally inconsistent

The plan does not consistently distinguish files that exist from files it will
create.

- The production policy and adapter already exist at
  `apps/zalo-account-gateway/src/runtime/reconnect-policy.ts:1-38` and
  `apps/zalo-account-gateway/src/runtime/zca-client.ts:67-186`, but the
  corresponding `reconnect-policy.test.ts` and `zca-client.test.ts` files do
  not currently exist.
- Phase 1 correctly creates `zca-client.test.ts`
  (`phase-01-start.md:67-70`), while Phase 2 calls it “Modify — existing”
  (`phase-02-socket-runtime-and-session.md:99-112`) and Phase 4 also calls
  both new tests “Modify” (`phase-04-regression-and-rollout.md:48-56`).
  Nevertheless, Phase 2 “Tests Before” already invokes `zca-client.test.ts`
  (`phase-02-socket-runtime-and-session.md:152-160`) and Phase 4 “Tests
  Before” invokes both missing files (`phase-04-regression-and-rollout.md:100-109`).
- The matrix names `account-lease-store.test.ts` as the owner for row 2
  (`reports/tdd-test-matrix.md:11-13`), and its production implementation is
  explicitly owned at `apps/zalo-account-gateway/src/runtime/account-lease-store.ts:64-147`,
  but the phase inventories and Phase 4 commands omit that test. The design
  contract also calls out `command-executor.ts` as affected
  (`reports/design-contract.md:109-116`), while the actual result union is in
  `apps/zalo-account-gateway/src/transport/command-executor.ts:27-42` and is
  absent from the phase file inventories.

Failure: a reviewer cannot run the stated baseline commands before creating
files, and the release matrix does not prove all of its named owners. A future
change to the command outcome union can also land without an inventory/test
owner.

Minimal fix: mark `zca-client.test.ts` as Create in the single phase that owns
its first behavior, mark `reconnect-policy.test.ts` as Create in its owning
phase, and remove both from “Tests Before.” Add the existing
`transport/command-executor.ts` and its test to the inventory only if the union
changes. Add `account-lease-store.test.ts` to the phase/command inventory, or
remove it from matrix row 2 if no behavior is being changed.

### 2. High — the database CAS/fence acceptance row has no database-level proof

The production invariant is transactional and concurrency-sensitive:
`packages/database/src/repositories/integration-zalo-account/repository.ts:31-73`
locks the account (`for("update")`), compares the runtime order, merges the
JSON snapshot, and returns an accepted boolean. The existing integration test
only covers uniqueness constraints at
`packages/database/__tests__/integration/zalo-account.test.ts:34-107`; it does
not exercise `withRuntimeFence`, stale/new concurrent refreshes, or sibling
JSON preservation.

The plan’s matrix nevertheless claims this proof for row 15 and T23/T24
(`reports/tdd-test-matrix.md:25-26,55-56`). Phase 3 changes the repository and
JSON shape but lists no database integration test or database test command
(`phase-03-safe-status-api-and-ui.md:102-141,186-193`). The design contract
only makes the new integration file conditional
(`reports/design-contract.md:107-113`), while the default package test and the
opt-in DB test are distinct (`packages/database/package.json:51-53`).

Failure: mocked business tests can pass while row-lock/CAS ordering, tenant or
inbox guards, or JSON sibling preservation are wrong; the high-risk “newer
auth wins” claim is therefore not executable acceptance evidence.

Minimal fix: either extend the existing integration file or create the
proposed `packages/database/__tests__/integration/zalo-account-runtime-state.test.ts`.
Cover concurrent stale/new `withRuntimeFence` calls, expected ciphertext
fingerprint behavior, workspace/inbox/UID scope, and preservation of unrelated
`operations` keys. Add its owner and an explicit approved-environment
`test:db` gate to Phase 3/matrix; do not apply migrations automatically.

### 3. Medium — status polling has a per-request budget but no workspace aggregate bound

The current UI renders one row per account
(`apps/builder/src/features/zalo-accounts/components/zalo-account-manage.tsx:145-173`),
and the existing row hook polls every 30 seconds
(`apps/builder/src/features/zalo-accounts/queries/use-account-operations.ts:11-28`).
The plan keeps a 30-second status poll per manage row
(`phase-03-safe-status-api-and-ui.md:78-83`) and specifies two DB reads plus
one Redis MGET per request (`phase-03-safe-status-api-and-ui.md:227-232`), but
it never states a maximum visible-account count, aggregate request rate, or a
counter test for N simultaneously visible rows. The design contract repeats
only the per-account budget (`reports/design-contract.md:121-124`).

Failure: a workspace with many Zalo accounts can generate N status requests and
2N DB reads plus N Redis MGETs every 30 seconds, in addition to realtime
invalidations. “Visible-only” reduces the scope but does not provide a bounded
workspace cost or prove that hidden tabs/closed panels stop all timers.

Minimal fix: state the aggregate formula and bound (for example,
`N_visible × (2 DB + 1 MGET) / 30s` with an explicit maximum or a batched list
query), define the exact visibility/enabled condition, and add a fake-clock
counter test at the chosen N. Keep the change within the status hook; do not
broad-refactor the groups/Connection paths.

## Verified non-findings

- **Coverage:** the current Phase 4 release commands run `vitest run --coverage`
  without focused test paths (`phase-04-regression-and-rollout.md:126-138`),
  and the shared preset includes `src/**/*.{ts,tsx}` with the existing 80%
  thresholds (`packages/vitest-config/src/node.ts:165-183`). The earlier
  focused-coverage/include concern is resolved in the current draft.
- **Rollout ordering:** the current sequence installs readers/schema/status,
  then worker/realtime consumers, then the gateway producer, then the UI
  (`phase-04-regression-and-rollout.md:169-175`); the design contract states
  the same reader-first rule (`reports/design-contract.md:104-105`). There is no
  remaining producer-before-consumer finding.
- **Blast radius:** the other-channel commands are regression tests only
  (`phase-04-regression-and-rollout.md:143-149`); no plan item authorizes
  changing those production integrations.

Status: DONE
Summary: Three material plan gaps remain: inconsistent new-test ownership and
baseline commands, no DB-level CAS acceptance proof, and no aggregate status
polling/resource bound. Coverage and reader-first rollout are verified in the
current draft.
Concerns: This report intentionally did not run tests/build/lint or edit source
and phase files; reconcile the inventory and acceptance commands before
execution.
