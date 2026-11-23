# Zalo Account P0 integration record

Date: 2026-11-23. Branch: `feat/zalo-account-p0-integration`.
Initial base: `origin/dev` at `b8480e030`, including P0.1 and the Redis startup/deployment ordering fix.

The user authorized integrating media, recall and message integrity in that order, preserving a commit per feature and opening one PR into dev. No PR merge, deployment or migration application is authorized.

## Frozen inputs

| Feature | Source branch | Source HEAD | WIP paths |
|---|---|---|---:|
| Media | feat/zalo-account-media-r2 | 1d53a89c2 | 150 |
| Recall | feat/zalo-account-recall-tracking | 1d53a89c2 | 148 |
| Integrity | feat/zalo-account-message-integrity | 134483fb3 | 115 |

All three referenced chats were read and reported idle. Binary patches and SHA-256 manifests were captured under `/tmp/zalo-p0-integration-inputs`. Original source worktrees remain untouched. The main checkout's branding WIP and index are separate and preserved. Feature commits are created on the integration branch.

## Media integration

Three-way application conflicted in ports, zca-client, public account service and checklist. Resolutions retain the current socket cancellation, cookie CAS, private metadata projection and P0.1 checklist; only media additions and its P0.2 checklist section are imported.

Integration fixes and fresh evidence:

- Sticker reads now reject immediately after socket close admission; gateway regression passes.
- Media capture during connect/reconnect introduced account → workspace locking, opposite to workspace purge. Added a Zalo-only workspace child-write guard before inbox/account writes. Four behavioral regressions failed before the fix; connect, reconnect and existing Messenger tests pass afterward.
- The generic received-message suite needed mocks for the newly introduced media service boundary; it now passes all 233 tests while retaining the feature-disabled path for other channels.
- Fresh focused results: gateway67 + SDK media2 + integration6; business53 + database30; builder238 + CLI47; connections132; worker118 + received-message233. Total 926 tests across 37 files pass. These are focused integration checks, not live or full coverage proof.
- Committed as `04c9c0c4e`; mandatory hook typechecks51/51 pass. Final combined evidence is recorded below.

## Recall integration

Committed as `9c13671e7`; mandatory hook typechecks49/49 pass. Focused gateway/SDK80, business/database119, worker303 and UI/API/CLI regressions pass. Recall saved-content now resolves exact private media references under the existing conversation ACL, including archive completion after recall. Normal media reads and readiness events respect durable recall/local hide. Provider-only delete remains visible in CRM as approved. Raw late-original attachments still enter retention even when the public message projection has none.

## Integrity integration

All source changes were integrated by separate gateway/SDK, data and UI owners; root owns worker, Git coordination and final verification. The joint review identified secondary provider ID recall vs canonical primary mismatch, confirmed-own-echo ingestion dropping archive evidence, and lifecycle markers being rejected by the integrity UI revision guard. Targeted fixes preserve the approved per-feature contracts. Worker focused verification currently461 tests/6files passes. Gateway139/23files, SDK82/3files and adapter6/1file pass. UI public-scope parity review adds21 passing tests. The whole-repo test gate found an omitted media queue in the existing exact routing test; after updating that documented routing assertion, its8 cases pass. Data focused checks150/11files pass. Final lint passes (invariants, locale parity, schema drift and all12055 files); worker and gateway builds pass. Integrity commit `f983fde4b` passed49/49 mandatory hook typechecks. Additional test-only isolation commits `99f997f57` (3 workspaces checked) and `1f6ca9a23` (builder checked) also passed their hooks. The final combined suite passes; see the gate table below.

## Combined behavior

Saved-content reads resolve exact private archived media under the existing conversation ACL. Ordinary message/media projections continue blocking recalled or locally hidden originals. Multi-ID reconciliation preserves the primary provider ID, all bounded media references and recall tombstones. Confirmed own echoes still enter canonical ingestion for retention, then bypass automation. Recovery is bounded and never replays a provider write automatically.

Independent migration snapshots were made cumulative in chronological order without changing their SQL. No DDL was applied. Source reports and narrow coverage counts are historical; the final combined gates below supersede their local test counts, while their live/coverage gates remain open.

## Review boundaries

[UI and public security review](./final-ui-security.md) found no open major issue in its inspected scope, and fixed plain caller-scope forwarding parity without changing token authorization. [Runtime review](./final-runtime-review.md) confirmed P0.1/PR5 compatibility and exact alias/purge guards. Both identified archive issues are fixed: alias binding reads at most301 references and fails before mutation when more than300 exist; alias maintenance continues while new transfers are disabled. Group capture remains separately gated, with a narrow pre-reconcile callback for existing references. Distinct assets sharing a provider slot are not collapsed, and attachment IDs that move with canonical reconciliation are preserved. Whole-workspace coverage in the source reports did not meet the unchanged80% threshold. Coverage has not been rerun on the combined branch, so that gate stays open; no bypass/exclusion was added. Live DB concurrency, Zalo and private R2 end-to-end evidence remains a rollout gate.

## Source preservation

Read-only parity review found all324 unique frozen input paths present and all168 production/configuration paths represented against dev. All15 new public operations remain (media6, recall/native8, integrity inspection1). P0.1 docs and PR5 deployment/startup changes remain. A fresh SHA-256 comparison of every frozen source file reports no changed source paths in any of the three original worktrees. The branding checkout remains separate.

## Deployment limits

No migration was applied. The cumulative snapshot chain is base → recall → integrity → media → media indexes, with source SQL unchanged and drift zero. Gateway, integrity writer, media transfer and native operation flags stay false. Generated core migrations require separate review and approval before any deployment depending on these tables/columns. This PR is not production enablement.

## Full-regression isolation repairs

Broader tests exposed pre-existing partial mocks crossing newly added service boundaries. Repairs only isolate the new dependency in the owning unit test; all existing assertions remain. These include the media bulk queue routing expectation, appointment external-calendar boundary, connection-start Zalo service, WhatsApp thread-control canonical-send boundary and MessageItem inspection action. The worker full suite now passes414 files/5,607 tests; business passes689 files/10,962 tests with opt-in integration skips. The final builder suite passes 1,260 files / 11,567 tests, with two existing skips. All nine direct MessageItem test suites and the message-list boundary were checked together (10 files / 89 tests); assertions were preserved.

## Final combined verification

| Gate | Result |
| --- | --- |
| `VITEST_MAX_WORKERS=4 pnpm test --continue=always` | PASS, exit 0: 71/71 Turbo tasks, 70 cache hits; workspace Vitest summaries total 39,560 passed, 1,234 skipped, zero failed |
| `pnpm lint` | PASS, exit 0: agent instructions/invariants, schema drift, locale parity and Ultracite (12,055 files) |
| Mandatory commit type hooks | PASS: media 51/51, recall 49/49, integrity 49/49; shared-boundary tests 3/3 and MessageItem tests 1/1 |
| Worker build | PASS (`pnpm --filter worker build`) |
| Gateway build | PASS (`pnpm --filter zalo-account-gateway build`) |
| Independent review | UI/public scope and runtime/archive findings resolved; no remaining concrete finding in the inspected scope |
| Real DB / private R2 / live Zalo | NOT RUN for this combined branch; rollout gate remains open |
| Whole-workspace coverage | NOT RERUN; source reports failed the unchanged 80% threshold, so this gate remains open |

The skip count is not a pass count. Opt-in database/integration suites were not enabled, and ordinary tests do not prove live provider or production behavior. Cached results are reused only for unchanged Turbo inputs; changed worker/builder suites were rerun after their isolation fixes. `--continue=always` collects all workspace failures rather than cancelling at the first one; the final command still exited zero with every task successful. No tests, assertions, thresholds or coverage exclusions were weakened.

All started build/test/typecheck processes exited. No dev server or production operation was started. The branch is prepared for one review PR into `dev`; merge and production enablement remain outside this task.
