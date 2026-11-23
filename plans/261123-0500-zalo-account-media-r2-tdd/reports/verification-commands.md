# TDD and implementation verification commands

Run later from `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`. This report is a command contract, not evidence of tests having run. New target files below are explicitly proposed future test files; write the test, observe its meaningful RED failure, then implement GREEN and refactor behind the same assertions.

## Focused RED/GREEN by phase

Phase1 — schema, queue, service and streaming downloader:

```sh
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/zalo-account-media-schema.test.ts __tests__/workspace-purge-coverage.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-media-service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/worker-config exec vitest run __tests__/zalo-account-media-queue.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-media-downloader.test.ts __tests__/low-worker-boot.test.ts
```

Phase2 — real event envelopes, typed capture, originals, profile/sticker and canonical echo:

```sh
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-message.test.ts __tests__/sticker-resource.test.ts __tests__/outbound-attachment.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run __tests__/message.test.ts __tests__/media-capture.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-canonical-send.test.ts __tests__/zalo-account-group-inbox.service.test.ts __tests__/zalo-account-friend-sync.test.ts __tests__/zalo-account-media-service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-media-ingress.test.ts
```

Phase3 — authorization, projections and bounded maintenance:

```sh
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-media-read-service.test.ts src/message/__tests__/list-for-conversation.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-media-maintenance.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/media-public-scope.test.ts __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts __tests__/attachment-url.test.ts __tests__/message-item-attachments.test.tsx src/features/zalo-accounts/__tests__/to-resource.test.ts
```

Phase4 — retention, purge and disable/rollback guarantees:

```sh
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/zalo-account-media-purge-coverage.test.ts __tests__/workspace-purge-coverage.test.ts __tests__/workspace-purge-repository.test.ts __tests__/purge-fk-indexes.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-media-purge.test.ts src/workspace-lifecycle/__tests__/purge-batch.test.ts src/workspace-lifecycle/__tests__/service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-media-production-gates.test.ts
node --test deploy/r2/public-reader.test.mjs
```

## Cross-channel regression gate

These existing owners must preserve their behavior. Do not rewrite fixtures to match a broader hydration/optimization policy.

```sh
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/filesystem exec vitest run __tests__/bounded-fetch.test.ts __tests__/upload-from-url.test.ts __tests__/upload-writer.test.ts __tests__/r2-uploader.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run src/media/__tests__/resolve-media-url.test.ts src/media/__tests__/optimize-stored-image.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/channel-registry exec vitest run __tests__/media-hydration.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/coexist-attachment-download.test.ts __tests__/enqueue-attachment-downloads.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/edge-instrumentation-graph.test.ts
```

If public procedures ship, run public spec tests above and CLI/MCP loader collision tests under their existing package scripts; inspect `cli-mcp-docs` before publishing docs. Do not start a server or refresh the production spec merely to pass a local unit test.

## Final gate in repository order

Focused RED/GREEN is the test-first development loop. The final gate remains lint → sequential types → affected tests → coverage. Avoid parallel cold builder typechecks.

```sh
pnpm lint
for media_workspace in @chatbotx.io/sdk @chatbotx.io/database @chatbotx.io/business @chatbotx.io/worker-config @chatbotx.io/filesystem @chatbotx.io/integration-zalo-account @chatbotx.io/connections zalo-account-gateway worker builder; do
  pnpm --filter "$media_workspace" check-types || exit 1
done
```

Then run the phase/regression commands above sequentially. For affected workspace coverage, keep the existing configured80% threshold and use their real Vitest coverage support. Do not set `VITEST_SKIP_COVERAGE_THRESHOLDS`, drop tested source from coverage merely to pass, or hide a failing broad baseline. Example full-suite gates after focused tests are green:

```sh
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run --coverage
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run --coverage
```

Run further touched-workspace coverage only when changed behavior/contracts require it. Missing coverage provider or an existing baseline failure is reported/fixed, never silently bypassed. Build the worker/gateway packages if Node-only import/serialization graphs change; run Edge graph test before considering new APIs safe for builder imports.

## Explicitly separate release checks

- New migration generation/SQL inspection belongs to implementation; no migration was generated or applied during planning.
- `db:migrate` needs explicit user approval, including for a plan that names it.
- DB-backed tests and EXPLAIN require a disposable approved DB; never use production merely because .env exists.
- Cross-replica BullMQ behavior, actual R2 ACL/private access, provider payload fixtures and measured resource caps require controlled staging validation; mocked unit tests cannot claim them proved.
- Stop task-owned test processes and temporary services after verification; prefer no background process for these commands.
