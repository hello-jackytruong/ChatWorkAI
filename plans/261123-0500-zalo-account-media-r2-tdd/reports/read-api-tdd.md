# Safe reads, public API and maintenance TDD evidence

2026-11-23; isolated worktree `/Users/jacky/.codex/worktrees/zalo-account-media-r2/ChatWorkAI`.

## Delivered contract

Six public operations mounted in the existing `zaloAccounts` router: `listMedia`, `getMedia`, `authorizeMediaDownload` use GET; `retryMedia`, `backfillMedia`, `reconcileMedia` use POST. Message-content operations require `inbox`, an explicit conversation and the existing member conversation authorization. Maintenance additionally requires `channels` and member management permission. A channels-only token cannot read media, and a read-only token cannot retry.

Business reads verify workspace/account, exact reference, conversation, current Message identity plus shard timestamp, `deletedAt`, and current ContactInbox/account inbox binding before signing. Missing/deleted/foreign parents cannot sign. A stored object can be read with capture disabled. Returned status is an allowlisted metadata projection; raw sources, encrypted locators and object keys are excluded. Download links expire after 300 seconds. Provider duration/dimension hints have explicit `provider` provenance; detected values have `detected`, absent metadata `unknown`.

Normal message reads perform one bounded ledger query per page, match current parents and inbox ownership, strip provider/private `originPath` and `thumbnailPath`, and project signed stored originals/preview roles into existing fields. Pending resources yield null URLs. Account and group read surfaces batch-project current stored avatar resources; profile helpers use owner tuples and current-account joins. Contact profile caller wiring remains with the controller. There is no provider/network/HEAD read during normal conversation projection.

Backfill reads persisted messages only within an explicit window of at most 31 days. Each page reads at most four messages, hence at most 48 resources under the 12-resource message bound, so a 50-resource tick cannot skip the rest of a partially processed message. It preserves the existing timestamp/ID pagination cursor and shared capture identity. Dry-run never registers; a write registers durable outbox intents through the existing service. No provider history API is called.

Reconcile is dry-run only: at most 50 scoped references and 100 account-prefix listed objects, independent continuation cursors, and one shared 15-second AbortSignal for all HEAD/LIST operations. It reports missing only for positive NotFound/NoSuchKey evidence; all other storage/database outages remain unknown. Known live/historical candidate keys are checked against the ledger. No object is deleted and no key is returned.

## RED → GREEN

- Read-service test initially failed because the module did not exist. After implementation, scope/deleted parent/account mismatch/stored flag-off/signing tests passed.
- Normal message projection RED exposed a provider query-token URL in `originPath`; implementation replaced it with a scoped signed original. Independent self-review added a thumbnail-path fixture, which failed because that locator remained visible; the fix strips it and projects only authorized signed previews.
- Backfill/reconcile tests failed on absent methods before implementation, then passed with real bounded persisted-row and storage diagnostic behavior.
- Builder public API test failed on absent media module, then passed channels-only denial, real inbox scope plumbing and read-only POST denial.
- Account avatar projection failed on missing batch mapper, then passed after wiring account/group projection.
- Public spec metadata gate exposed missing field descriptions and summary style issues; fixed the operation metadata. Snapshot delta contains exactly the six new operations.

## Verification

All focused Vitest commands used `VITEST_MAX_WORKERS=1` with `exec vitest run`.

- Business read-service: 16 tests passed. Coverage command: `pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-media-read-service.test.ts --coverage --coverage.include=src/zalo-account-media/read-service.ts` (with `VITEST_MAX_WORKERS=1`). Thresholds unchanged: statements 98.03%, branches 95.67%, functions 100%, lines 98%.
- Existing normal message reads plus new private projection: 19 tests passed.
- Builder media scope and avatar projection: 4 tests passed.
- CLI six-command uniqueness test passed and pins exact generated command names. `apps/cli/README.md` now documents those commands and scope/cursor/dry-run semantics.
- Focused formatter checks were run against owned files; controller runs repository-wide lint and sequential typechecks. Heavy tsc runs were interrupted on controller request to avoid parallel memory pressure, not claimed passed here.
- Public spec operation/MCP/options/JSON-route suite running after metadata fixes; final result appended below.

No migration application, production/provider calls, live dev server, commit or merge. Live CLI/MCP verification requires an existing running builder and was not claimed; the generated spec and command-loader tests are the available local evidence. Separate `chatbotx-agent` repository documentation was not edited in this checkout.

Final public contract gate: `public-spec-operations.test.ts`, `public-spec-mcp.test.ts`, `public-spec-options.test.ts`, `public-spec-json-route.test.ts`: **4 files / 84 tests passed** after metadata corrections. The operation snapshot was inspected and adds only the six requested media operations.

## Review-driven completion

The controller approved two explicit read modes on the same six operations: message references require `conversationId` and inbox/member access; non-message resources require `ownerKind`/`ownerId` and channels management authority. Business verification checks the current account, provider-group row, or provider-UID ContactInbox before any profile download. Inbox-only tokens cannot manage profiles; channels-only tokens cannot read message content. These inputs are mutually exclusive, with no arbitrary URL/key input.

Production compatibility correction: capture defaults off. For an authorized nondeleted legacy message with no ledger resources and capture disabled, normal reads retain the pre-existing media resolver behavior. Stored/private ledger resources always use the new scoped projection, and deleted messages never take that legacy fallback. A RED legacy internal-object read test failed before this correction and passed afterward. This is an explicit legacy compatibility exception, not permission to expose newly captured private source descriptors.
