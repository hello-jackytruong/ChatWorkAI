# P0.4 implementation evidence

Date: 2026-11-23 (Asia/Ho_Chi_Minh). Branch: `feat/zalo-account-message-integrity`.
Worktree: `/Users/jacky/.codex/worktrees/zalo-account-integrity/ChatWorkAI`.
Implementation baseline: `134483fb3`; existing socket/session changes retained.

## Scope and delivery

User approved implementation via `/ak-cook` with TDD and parallel agents. Three disjoint implementation owners handled gateway/admission, durable reconciliation, and public API/Inbox. Controller handled SDK contracts, integration/worker wiring, shared-path Zalo guards, central verification and documentation. Independent review, simplify review and invariant audit followed. Original shared checkout was not switched or reset. No commit/push/deploy was requested or performed.

- Direct/group normalized metadata and bounded unsupported evidence; legacy wire shape retained with producer gate off.
- Atomic ACK winner, at most ten confirmed aliases, observed client IDs, stable primary and exact-own-echo resolution. Text/time similarity is not ownership proof.
- Conservative opt-in alias cleanup with sorted locks, attachment/reply preservation, translation and cross-store safety fallback. Existing non-Zalo default reconciliation path retained.
- Durable local repair on existing scheduler, monotonic revisions, no provider replay, nullable operational JSON plus partial index; no new table/queue/framework.
- Structured safe errors, direct admission and existing group budgets, read-only retry, bounded diagnostics/backlog and same-frame publishing retry.
- Authorized public GET inspection by Message pointer, existing command route retained, on-demand Inbox inspection and localized evidence, safe resend policy.
- Existing messageContentUpdated event publishes fresh primary evidence. Atomic DB revision guard and client revision guard prevent stale completed evidence replacing a newer conflict. After a versioned marker is present, legacy/missing-revision content snapshots cannot erase it.

## Actual TDD evidence

- SDK initial RED: four failures of six (unsupported marker rejected, missing safe evidence/error helpers, lost cooldown metadata). GREEN followed; complete SDK suite now passes with 100% coverage of the Zalo SDK module.
- Integration initial RED: inbound recipientId/isSelf/threadType absent from persisted attributes. GREEN five adapter tests.
- Gateway RED: missing placeholder, own-UID conflict, normalization throw, circuit map beyond cap, read retry and direct admission. Review exposed long valid text/URL regression; regression cases failed with both gate states before fix.
- Durable service RED: losing transport ACK returned instead of stored winner; empty provider ID accepted. Repository alias budget test exposed absent opt-in path.
- Builder RED: Message-pointer GET/action absent and evidence UI absent. Actual channels middleware read-only/missing-scope cases verified.
- Client revision regressions RED (both lower revision and missing-revision legacy snapshot): late revision4/completed replaced revision5/needs_review (110 existing tests passed). GREEN111 after narrow Zalo revision guard.

## Independent findings and resolutions

1. Long supported text/signed URL truncation: separate identity/content/URL caps; gate-off/on regression tests.
2. Cross-shard reply orphan risk: refuse destructive cleanup when canonical/current stores differ; retain data for review.
3. Group overlay lost account/send evidence: preserve current nested JSON.
4. Inbox remained pending after DB update: scoped content update event from fresh primary reads.
5. Conflicting ACK raced stale completed projection: durable CAS, revision increment, atomic marker guard, client stale-event guard.
6. Recovery five-second claim: documented accurately as admission budget, with new transactional lock500ms/statement1s limits. Existing account/registry reads can exceed that wall-clock duration.
7. Replica reads could publish stale pending evidence: both before/after evidence reads use primaryAndFailOnError.

Simplify review retained alias preflight/locks because they enforce approved invariants. Rejected suggestion to render/resend legacy Zalo failures without evidence: arbitrary old sendError is not proof of failed provider dispatch and must not expose raw provider data. Other-channel errors remain unchanged. Invariant audit: PASS, no concrete violations.

## Verification

Central final gate results (all pools capped; typechecks run sequentially):

| Gate | Result |
| --- | --- |
| pnpm lint | PASS: invariants, skills, schema drift, all locale keys, Ultracite |
| Touched typechecks | PASS: SDK, database, business, Zalo integration, gateway, worker, builder (7/7); final client guard builder recheck also PASS |
| SDK full suite | 20 files /349 pass |
| Gateway full suite | 20 files /111 pass |
| Business Zalo + shared message regression | 17 files /208 pass |
| Worker send/flow/receive/boot/recovery | 6 files /459 pass |
| Database sharding/aliases/ACK | 3 files /100 pass;1 real-DB file/test skipped |
| Builder UI/store/auth/spec/MCP/Edge | 9 files /214 pass; final revision guard rerun111 pass |
| CLI command-name collision | 46 pass |
| Zalo integration adapter | 5 pass |
| Worker build | PASS (tsdown) |
| Gateway build | PASS (tsdown) |
| Review / invariant / simplify gates | Completed; reported correctness bugs fixed, no final specific blocker |
| Whole SDK/gateway coverage | FAIL, thresholds retained; details below |

Totals for the listed distinct suites:1,492 passing tests,1 explicit real-DB skip. Repeated runs are not added to totals. No test failure is hidden by that count: coverage commands still exit1 as documented.

Per-owner evidence:

- [Gateway/admission](./gateway-implementation.md)
- [Durable reconciliation](./reconciliation-implementation.md)
- [API/Inbox/CLI](./builder-implementation.md)

SDK full suite: 20 files / 349 passing tests. Zalo SDK module: 100% statements, lines, functions and branches. Whole SDK coverage command exits1 with unchanged80% thresholds: lines82.68%, functions75.17%, branches72.85%; uncovered non-Zalo functions/branches remain. No coverage exclusions or bypass variable were added.

Gateway full suite: 20 files / 111 passing tests. Whole gateway coverage command exits1: lines72.99%, functions65.88%, branches67.01%. Package-wide coverage gate is not GREEN.

## Release gates and operational limits

- Real PostgreSQL interleaving suite added but skipped under the non-routable sentinel; skipped does not count as pass. Use a dedicated disposable test DB with DATABASE_URL pointing to that DB and ZALO_ACCOUNT_DB_TESTS=1 after separately reviewing/applying its migration. Never load production credentials to run it.
- Migration `packages/database/drizzle/20261123081808_zalo_account_local_reconciliation/migration.sql`: generated and inspected only; nullable JSONB and partial due-work index; drift check passed. Applying migration requires separate explicit user approval per repository instructions.
- No live Zalo/provider smoke, Redis/gateway restart staging, or live CLI/MCP refresh claimed. Generated-spec/API, command-name collision and Edge graph tests cover offline contracts.
- Excess callbacks are diagnosed and readiness is degraded; this does not create durable provider ingress or guarantee replay after process death before stream append. Publisher retries the same event/frame at most twice within two seconds.
- Five seconds is a scheduling/admission budget, not promise cancellation. No abandoned work is hidden behind Promise.race.
- Cross-store/translated/over-budget ambiguous cases retain data as needs_review. No automatic destructive distributed merge.
- Additive schema before dependent code; compatible readers before enabling ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED. Disable message producer and drain new-format events before downgrading strict readers. Structured command-result errors also require compatible readers; retain those readers until new-format retained command results are drained/expired. The message producer gate only gates normalized message fields. Preserve data on rollback.

Final lint, all seven touched typechecks, final builder recheck and both builds passed. No owned background server/watcher remains. Implementation is available for review; production-ready status remains pending the explicit release gates above. No live approval is implied by test results.
