# Existing production-channel and public-surface regression checks

Date: 2026-11-23. Read `cli-mcp-docs` and `testing-workflow`; discovered actual test files before running them. All commands below ran sequentially from the repository root with a single Vitest worker. This task changed no source, snapshots, dependencies or configuration.

## Exact commands and results

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/lifecycle.test.ts __tests__/messenger-teardown.test.ts
```

**2 files / 16 tests passed**, exit 0 (335 ms reported Vitest duration).

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo exec vitest run __tests__/connection-oauth.test.ts __tests__/refresh-access-token.test.ts __tests__/webhook-routing.test.ts
```

**3 files / 14 tests passed**, exit 0 (2.52 s). This is the existing Zalo OA integration, distinct from Zalo Account.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-messenger exec vitest run __tests__/connection-oauth.test.ts
```

**1 file / 8 tests passed**, exit 0 (1.63 s).

```bash
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/connection-status-message.test.ts __tests__/edge-instrumentation-graph.test.ts __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts __tests__/workspace-realtime-provider.test.tsx
```

**5 files / 90 tests passed**, exit 0 (21.11 s). Includes generated public-operation/MCP metadata, existing connection-status presentation, workspace realtime behavior, and the Edge router-import graph.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter chatbotx exec vitest run __tests__/openapi-loader-command-names.test.ts
```

**1 file / 46 tests passed**, exit 0 (80 ms). The discovered collision regression file is `apps/cli/__tests__/openapi-loader-command-names.test.ts`.

Total: **12 files / 174 tests passed**, no failures or skipped tests reported. Non-fatal output: pnpm warns that root `pnpm.overrides` / `pnpm.updateConfig` fields are ignored; integration suites emit the Node experimental localStorage warning. Neither warning changed test outcomes.

## CLI/MCP applicability and limits

No public route, operation ID, method/path, resource scope or MCP visibility was added or renamed. Existing channels-scoped `GET /v1/zalo-accounts/{accountId}/status` (`zaloAccounts.getStatus`) gains optional/null safe runtime data; its description now explains verified runtime state and unknown `socketOpen`. CLI and MCP derive this existing operation from the OpenAPI spec, so no new command group, default-tool entry or collision-documentation change is indicated. Generated operation/MCP tests and the existing collision regression suite passed. Root owns the product/runbook documentation update.

No builder server, production process, live provider authorization, live CLI spec refresh, MCP tools/list session, migration, build, typecheck, coverage, commit, push or deploy was started for this task. Live CLI/MCP verification and Zalo login/kick/restart staging proof remain unavailable in this report; these focused tests do not establish live production readiness. Root owns the remaining full verification gates.

### Read-only live-gate availability check

Checked the documented local builder port without starting a process:

```bash
lsof -nP -iTCP:3123 -sTCP:LISTEN
ps -axo pid=,command= | rg '(next (dev|start)|next-server|chatbotx-mcp)'
curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}\n' http://localhost:3123/api/public-spec.json
```

`lsof` reported no listener; `ps` found only the inspection command and its `rg` process, no builder or MCP server. The public-spec request failed immediately with curl exit **7**, HTTP **000** (connection refused/unavailable). Consequently live CLI `--refresh-spec` help and MCP live tool-surface verification cannot use an existing local builder. No server or substitute spec server was started; no credentials or configuration were read or changed. The live gate remains **not run / unavailable**, independently of passing generated-spec tests.

### Full-suite parity guard follow-up

Full builder verification caught the newly exported status-only action missing from the existing action/API parity manifest. Added `zalo-accounts/account-operations.action:getZaloAccountStatusAction` as `covered:zalo-accounts`, matching the existing public getStatus service route. No route, visibility, scope or channel implementation changed. Narrow rerun of api-parity-manifest, Zalo public API and action-permissions tests passed **3files/15tests**,exit0. Scoped Biome on the manifest passes. The original full coverage invocation is still recorded with its failure and is not presented as a successful coverage run.
