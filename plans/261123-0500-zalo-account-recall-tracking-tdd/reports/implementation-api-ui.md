# Implementation: API, Inbox and final gates

Status: CODE IMPLEMENTED / UNIT & REGRESSION PASS — release gates remain unresolved.

Worktree: `/Users/jacky/.codex/worktrees/zalo-account-recall-tracking/ChatWorkAI`.
Branch: `feat/zalo-account-recall-tracking`, isolated from freshly fetched `origin/dev` at `1d53a89c2`.
Original checkout and other chats' socket/media/integrity changes are untouched.

## Implemented

- Eight public procedures with `inbox` scope, exact tuple inputs, safe outputs, destructive annotations and conversation ACL before service calls. Shared services also power private authorized Inbox actions. Trial-expired deletion remains allowed; read-only token mutations and scheduled deletion remain blocked.
- Saved-content dialog fetches only on demand, full tuple query key, no persistence, zero cache lifetime. Close/tuple change cancels/removes query and clears locally held signed links. Stored-only file URL issued after separate authorization. Provider URL/unarchived media never hydrated. Added tuple timestamp to React key after RED stale-link test.
- Distinct local hide, own recall, delete-only-me and conversation clear confirmations. Immutable deleteChat boundary. Pending/unknown has inspect-only status, no automatic resend or optimistic recall.
- ZA-only bubble/sidebar labels, separate provider-delete badge retaining local content, safe attachment/raw content suppression. 32 new strings localized across 21 existing locales.
- Server read projection before attachment signing, final projection after translation; batch sidebar projection and old ordinary-media-token guard. Client loaded-state/quote fences resist stale pages, translations, tracking and realtime. No new history scan or polling.
- Existing CLI deletion names collided; RED→GREEN narrow naming overrides distinguish message and conversation deletion. Other endpoints use runtime-derived names; no wrappers/default MCP payload expansion.

## TDD and regression evidence

- API routes: initial five behavioral RED failures for absent routes, then GREEN; later added full registration scope assertion.
- UI saved/native: 15 real React/fresh QueryClient tests GREEN, including timestamp tuple change/clear, gate off, denied/notCaptured, stored-only media, unknown inspect, boundary race.
- Bubble/preview: two behavioral RED failures for original visibility/generic label, GREEN. Provider-delete badge RED→GREEN retains original locally.
- API/spec/Edge/middleware/translation focused final pass: 6 files / 135 tests GREEN. Real token middleware new deletion paths exercise expired owner, read-only token and scheduled-deletion gates.
- Other focused runs: 7 files / 120 tests GREEN; CLI command collision 47 tests GREEN. Counts overlap; do not sum.
- Generic message-service read/delete mock updated for its new unrelated ZA projection dependency; 22 tests GREEN. This is test isolation, not a service behavior stub in production.
- Reviewer identified and re-reviewed three High fixes: historical shard original fill, purge/repair race, duplicate historical placeholder retry. Additional native queued lease/expiry and group settlement fixes have focused tests. See independent review report.

## Gates and release limitations

- Final full lint PASS (11,975 files), schema drift and i18n parity PASS.
- Final database/business/SDK/worker/gateway/builder/CLI types PASS. Retention helper shape mismatches found by builder types were fixed and checked again.
- SDK full tests 269 passed; full coverage fails intact: statements 76.87%, lines 76.99%, functions 63.63%, branches 62.19%.
- Gateway full tests 66 passed; full coverage fails intact: statements 58.27%, lines 58.55%, functions 46.96%, branches 54.71%.
- All affected full suites have completed. Clean final business, worker and builder tests pass; all workspace-wide coverage checks fail at least one intact 80% threshold. No threshold bypass or coverage config change. No baseline measurement: do not attribute gaps to pre-existing code without evidence.
- Additive SQL generated/inspected, NOT APPLIED. DB integration/EXPLAIN/crash/race proof requires explicit disposable DB setup/migration authorization.
- Native gate remains OFF. No live provider calls. SDK 2.1.2 disposable DM/group proof and verified production status classifier remain required. No production-ready/100% claim.
- Exceptional backdated rows outside registered shard ranges remain pending rather than falsely acknowledged; no unbounded scan/backfill introduced.

## Change boundary

Two narrow main-DB metadata tables, existing Message/Attachment bytes retained, receipt/reaction latest-state 90-day purger unchanged. No Message/shard DDL, new queue/daemon/dependency, channel-wide delete rewrite, or original R2 ingestion framework. Ordinary legacy media proxy adds one exact parent check because token/attachment lookup does not carry channel; other-channel media outcomes remain characterized unchanged.

No migration, commit, push, merge, deploy or native enablement performed.

Independent invariant-guard source review: PASS (relations/FK/drains, guard, public/private services, i18n, no direct DB/dynamic imports/Edge Node graph changes). Conditional simplify ran with scoped callback cleanup; 13 UI tests passed after it.

Full business initial run: 677 test files passed, 52 skipped, one suite failed at module import due missing unrelated Redis mock dependency reached by new projection import. 10,806 tests passed, 552 skipped; the failed suite is corrected and its 22 tests pass separately. Clean full business coverage rerun scheduled at the end of the serial coverage chain. No skipped-coverage flag is present.

## Final source-review corrections

- Shared generic characterization mocks now isolate the new dependencies exactly: Zalo lifecycle subpath in two worker suites, recall projector in three sidebar/read suites, server-action component seam in MessageList. Kongming verified the failing worker import chain; no random schema exports or assertion weakening was used. Worker received/integration suites: 256 PASS.
- Sparse conversation previews caused unrelated thread-control/contact-update fixtures to fail. Normalization now skips missing/empty previews. Existing thread-control logic/fixtures remain unchanged; 197 combined retention/thread-control tests and 3 contact-update tests pass. Sidebar batch results are mapped using the owning query context, preserving attachment counts even in compact fixtures.
- Legacy outgoing quote snapshots are now resolved and redacted, with a safe retainedQuote lifecycle marker preserved by the server. The client uses that marker to prevent later raw state updates from restoring an off-page recalled quote. Minimal source-gated blockquote labels preserve reply text. Core 10 and bubble 29 tests PASS; independent final security review marks the High finding resolved.
- Reauthorization failure while a saved-content dialog is open replaces cached data with null and unmounts the local signed-link state. File-access denial rechecks original access. Saved/native UI: 15 tests PASS, including two new RED→GREEN denial cases. No persistent query cache exists in the builder.
- Delayed placeholders across two shard rotations now route stable ZA creation to a registered primary covering the reserved timestamp. Non-ZA creation is unchanged. Actual stateful three-primary test RED→GREEN; 102 sharded tests and final DB types PASS.
- Five private actions are classified as covered:zalo-accounts in the existing API parity manifest; four manifest tests PASS.

## Coordinated final results

| Workspace | Full test evidence | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- | --- |
| database | 1,968 passed, 616 skipped; latest routing targeted 102 passed | 54.21% | 39.83% | 39.52% | 53.94% |
| business | 10,829 passed, 552 skipped | 77.82% | 72.23% | 73.75% | 77.92% |
| worker | 5,514 passed | 82.91% | 76.23% | 84.27% | 82.96% |
| sdk | 269 passed | 76.87% | 62.19% | 63.63% | 76.99% |
| gateway | 66 passed | 58.27% | 54.71% | 46.96% | 58.55% |
| builder | 11,519 passed, 2 skipped | 48.38% | 43.67% | 39.38% | 48.53% |

Global thresholds remain 80% on all four metrics. No bypass, lowered threshold or coverage config changes. These are workspace-wide results; no pre-change baseline was measured, so gaps are not attributed to existing code. Closing them globally would require a separately bounded testing scope rather than broad unrelated source changes.

Lint PASS over 11,975 files, i18n parity PASS, migration drift PASS, whitespace diff PASS. Initial full builder/worker runs exposed the fixed regressions above; a clean worker run now passes all tests. An early single-worker builder restart was intentionally stopped after the worker result was preserved; the final builder-only run uses two workers, one suite at a time, after compilers stopped, to reduce wall time with bounded memory. Interrupted run is not counted as evidence.

Final builder verification: **1,255 test files PASS / 11,519 tests PASS / 2 skipped**, 416.22 seconds with two workers. Clean full-suite test counts across the six affected workspaces total **30,165 passed**; CLI command-name regression adds 47 passed separately. The database full-suite snapshot predates the final private routing correction; all 102 sharded repository tests and DB types were rerun after that correction. No relevant failed test remains unresolved.

Final source checks: database, business, SDK, worker, gateway, builder and CLI typechecks PASS; lint, i18n, drift and diff whitespace PASS. Independent security review and invariant-guard PASS after corrections. Conditional simplifier made scoped UI callback edits. Original main checkout and sibling worktrees were preserved.

No 100%/production-ready claim: global coverage remains below threshold; opt-in real DB concurrency/EXPLAIN, migration application, controlled SDK DM/group proof and live CLI/MCP instance checks remain open. Do not close the plan or enable native dispatch on unit evidence alone. No servers/watchers were started; completed test/type processes left no owned background task. Journal saved locally; AgentWiki publish skipped.
