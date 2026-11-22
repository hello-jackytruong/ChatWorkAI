---
phase: 11
title: "Group controls and automation policy"
status: completed
priority: P1
effort: "L"
dependencies: ["Phase 10"]
---

# Phase 11: Group controls and automation policy

## Execution status

Implementation and static verification passed on 2026-11-21. Evidence: [review](./reports/implementation-review.md). Live provider/database/instance checks remain under Phase 16 and are not claimed as completed.

## Goal

Make group receive, send, and automation independently controllable and fail closed at account, group, and command boundaries.

## Policy contract

- Account-level `groupMessagingEnabled` is the kill switch and defaults false. Every change advances a policy epoch carried by group events/jobs/commands and rechecked immediately before persistence/provider admission.
- Per group: `receiveEnabled=false`, `sendEnabled=false`, and `automationMode=disabled | mentionOnly | all` default `disabled`.
- Only accessible, synchronized, allowlisted groups can be enabled. Gateway group sync returns a typed result with `complete`, reason, provider total/cursor, and detail-page status. The 1,000-ID cap, missing detail, timeout, or unknown completeness is partial and leaves missing groups/policies/anchors unchanged; only a fenced, proven-complete run may mark a missing group inaccessible and turn its controls off.
- `mentionOnly` automates only inbound, non-self messages whose normalized mentions contain the connected account `zaloUid`; text matching `@name` is insufficient.
- Receive disabled means no message persistence. Send disabled blocks Inbox, flow, private UI, public API, CLI, and MCP at the same service gate.
- Automation disabled still allows Inbox persistence when receive is enabled.
- Group automation uses a typed deny-by-default `GroupAutomationAction` allowlist containing only Zalo Account sendText/sendImage/sendFile and add/remove tag. Enqueue and execution both reject every other current or future dispatcher entry, including API/JavaScript, AI, CRM, contact lifecycle/fields, sequence/broadcast, assignment, appointments, and commerce.
- Rate limits apply per account and per group before provider commands; provider admission/circuit state remains the outer gate.
- Every policy mutation and group send records workspace, account, group, origin (`inbox | flow | api`), actor/token identity where available, command ID, outcome, and timestamp without message bodies or secrets.

## Files to modify/create

- Group/account schema, partial enum, repository/service/resource schemas, migration, purge/default-parity tests.
- `packages/business/src/zalo-account/group.service.ts` plus a small policy evaluator module.
- Gateway/transport admission keys for account/group token buckets; no second retry loop.
- Worker group handler and typed audience/automation guards across trigger jobs, flow jobs, action scope, retries, and Wait/resume.
- Public/private policy callers are exposed later in Phases 14–15 but must call the same service method.

## TDD sequence

### RED

1. New account/group rows default completely off in TypeScript and generated DB SQL.
2. Cross-workspace/account/group changes fail; inaccessible groups cannot be enabled; partial/truncated/missing-detail sync never tombstones an existing group.
3. Receive/send/automation combinations behave independently.
4. `mentionOnly` accepts an exact account-UID mention and rejects name-only text, other mentions, malformed spans, and self echoes.
5. Account kill switch overrides all group flags.
6. Account/group rate limits reject before provider execution and do not replay unknown sends.
7. Every existing dispatcher entry is exercised with a group audience: only the explicit send/tag allowlist runs; all others return a structured skipped/unsupported result with zero external calls and zero customer writes, including after retry or Wait/resume.
8. Audit assertions cover Inbox, flow, and public API origins without credentials/message content.
9. A queued job/command with a stale policy epoch becomes a non-retryable no-op after kill-switch/flag changes; rollback parks delayed group jobs while direct jobs continue.

### GREEN

1. Add enum/columns/defaults/index changes and inspect the migration without applying it.
2. Centralize `resolveGroupPolicy` and require it in receive, Inbox send, flow send, API send, policy mutation, worker execution, and provider admission. Include the resolved epoch in every event/job/command.
3. Provision the Phase 10 anchor when receive turns on; retain history when it turns off.
4. Add bounded Redis token-bucket/admission keys scoped by account and group; return retry-after metadata.
5. Carry a typed durable `person | zaloAccountGroup` audience—with workspace/account/group/provider identity plus ContactInbox/Conversation IDs—through trigger/flow jobs, occurrence keys, retries, action scope, and Wait/resume. Enforce the closed allowlist both before enqueue and immediately before execution; never fall back to a Contact's latest conversation for a group audience.
6. Record audit outcomes in the business layer after scope/policy resolution.
7. Make group sync completion explicit and fence stale run completion so an older run cannot tombstone rows from a newer run.

### REFACTOR

- Keep booleans/enums as data; avoid a pluggable policy engine.
- Reuse existing provider-wide admission and audit primitives.
- Keep mention parsing in the gateway normalizer and policy evaluation in business/worker code.

## Focused verification order

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-group.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts __tests__/trigger-action-executor-add-tag.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-admission.test.ts
```

## Success criteria

- [x] All policies default off and are enforced identically across every caller.
- [x] Mention-only is UID-based, self-safe, and covered by malformed payload tests.
- [x] Rate/audit behavior is scoped and secrets/message bodies never enter logs.
- [x] No customer-only automation can mutate a group anchor.

## Rollback

Set the account kill switch false and advance the epoch; park/cancel delayed group jobs, reject stale in-flight work at worker/provider admission, then drain group work. Direct messages continue unaffected.
