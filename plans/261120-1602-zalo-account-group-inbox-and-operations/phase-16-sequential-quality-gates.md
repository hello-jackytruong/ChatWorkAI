---
phase: 16
title: "Sequential tests, quality gates, and rollout proof"
status: in-progress
priority: P1
effort: "L"
dependencies: ["Phases 10–15"]
---

# Phase 16: Sequential tests, quality gates, and rollout proof

## Execution status

All repository gates passed again after five reported runtime fixes: 38,178 tests, lint, 70 type tasks and 7 production build tasks. Approved migrations, live PostgreSQL cases, direct/group sends, incoming text, quotes, self echo, typing acknowledgement, native/local tags, image/file delivery, reaction adds and undo were observed. Reaction removal remains unconfirmed; no removal event was observed yet. Evidence and limits: [staging verification](./reports/staging-verification-2026-11-21.md). Production cohort enablement is outside the staging authorization.

## Goal

Prove the complete items 10–16 contract without parallel commands, migration shortcuts, secret exposure, or regressions to direct messaging/Zalo OA.

## Mandatory execution rule

All resource-intensive commands in this phase run in one foreground sequence. Never overlap an install, generator, test, lint, typecheck, build, gateway, worker, or dev-server process. Latest user instruction (2026-11-21): set `VITEST_MAX_WORKERS=3` at most; set Turbo `--concurrency=1`. Complete implementation before full tests, then lint after tests pass. Small read-only log inspection does not start another workload.

## Required test matrix

### Contracts and security

- Group/direct normalizers, mentions, quote/media bounds, transport versioning, malformed/oversized events, durable inbound dedupe beyond queue retention, secret projection, tenant/workspace/account scoping.
- QR lifecycle, lease/fence stale callback rejection, reconnect/circuit/admission behavior, account lifecycle status.

### Messaging and policy

- Direct DM regression, self echoes, one group/one conversation, actual sender identity, receive/send/automation combinations, mention-only, kill switch/policy-epoch fencing of queued work, rate limit, audit.
- Attachments/replies, delivered/seen ordering, typing expiry, reaction add/remove/replay, undo-before-message, revoke/delete capability gate.

### Data integrity

- Group-anchor customer exclusions including the O(1) stats path/writers and export, quota/MAC reconciliation, broadcast/sequence/lead/customer scoring isolation, workspace purge/index/retention/tombstone coverage, default parity, tenant isolation.
- Label complete/partial/stale/conflict/unknown/grace/reconciliation behavior and direct/group tag mapping.
- Friend sync Zalo Account UID identity, bounded chunks, crash-recoverable exactly-once quota accounting, no MAC/customer-created effects, non-destructive partial result.

### Agent/UI parity

- Public scope/operation/MCP spec, private-action permission bypass, CLI name collisions, safe outputs, UI/private/public convergence, query invalidation, i18n parity, Edge instrumentation graph, existing Zalo OA tests.

## Sequential focused suite order

Run focused files from Phases 10–15 first in their listed order. Then run these workspace suites one by one:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter chatbotx exec vitest run
VITEST_MAX_WORKERS=1 pnpm --filter chatbotx-mcp exec vitest run
```

Database-backed integration tests remain conditional on explicit migration approval and a prepared test DB. Planning/implementation must not silently apply migrations to unlock them.

## Final repository gates — exact order

```bash
VITEST_MAX_WORKERS=3 pnpm turbo run test --concurrency=1
pnpm check:agent-instructions
pnpm check:invariants
pnpm turbo run lint --concurrency=1
pnpm exec ultracite check
pnpm check-types:cold
pnpm turbo run build --concurrency=1
```

Do not substitute bare `pnpm turbo check-types` or the default root test/build command because they can fan out and exhaust RAM.

## Review gates

1. Run invariant review after edits under apps/packages/integrations; resolve every evidence-backed violation.
2. Run security review for workspace scope, QR/auth projections, rate limits, audit redaction, and group-anchor authorization.
3. Inspect every generated migration SQL/snapshot for defaults, indexed FKs, relation registration, drift, and bounded purge behavior.
4. Update `docs/zalo-account.md` only after behavior/tests match the claims; run `cli-mcp-docs` after public operations settle.

## Live provider gates

After static gates pass, validate the report's live-account cases sequentially on a bounded staging account: identity/echo, mentions/replies, media, receipts, typing, reaction, undo/delete, group changes, profile/roster observations, reconnect overlap, and injected failure/admission. Record redacted fixtures and SDK version. Absence of typing/delete support is an explicit capability result, not a test failure to bypass.

## Rollout order

1. After explicit approval, apply inspected additive migrations in order. New code reads the added Contact/account columns; it cannot be deployed against the old schema.
2. Deploy builder, workers and gateway with account group kill switches off.
3. Enable one internal staging account; validate metrics, lag, unknown outcomes, and rollback.
4. Enable a bounded workspace cohort; keep per-account/group controls off until explicitly selected.
5. Roll back by disabling group kill switches before rolling back workers/gateway; preserve direct-message compatibility.

## Success criteria

- [x] Every focused, workspace, invariant, lint, type, full test, and build gate passes in the prescribed single-command sequence.
- [x] Migration application and live-account enablement have separate explicit approvals/evidence.
- [x] No Zalo Account secret or raw provider payload reaches API/UI/logs.
- [x] Direct Zalo Account, Zalo OA, and unrelated channel regressions are green.
- [x] Rollback disables group behavior without stopping direct messages.
