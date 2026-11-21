---
phase: 10
title: "Full Zalo Account group Inbox"
status: completed
priority: P1
effort: "XL"
dependencies: ["Items 1–9", "Explicit approval before applying migration"]
---

# Phase 10: Full Zalo Account group Inbox

## Execution status

Implementation and static verification passed on 2026-11-21. Approved staging verified real PostgreSQL anchor contention, group text send/receive, sender metadata, self-echo reconciliation, outgoing quotes and image/file delivery. Evidence and exact limits: [staging verification](./reports/staging-verification-2026-11-21.md). Additional lifecycle observation remains tracked in Phase 16.

## Goal

Persist one policy-controlled Inbox conversation per Zalo group while preserving actual sender identity and keeping group anchors outside customer semantics.

## Requirements

- Keep `IntegrationZaloAccountGroup` as the group source of truth; add `contactInboxId` and `conversationId` anchor references with indexed nullable FKs.
- Add `Contact.kind = person | channelGroup` with a real DB default of `person`; all existing inserts remain person by default.
- Provision the anchor transactionally when group receive OR send is enabled (user-approved on 2026-11-21). Send-only provisioning must not enable receive or persist inbound messages. Lock/CAS the group row, use one stable reserved source key, re-read a uniqueness-conflict winner, and commit both anchor references together; concurrent disable wins by policy epoch and never deletes history. Sync group name/avatar to the anchor; member count remains on the group resource.
- Use one reserved Conversation source key for Zalo Account groups. A member UID is message actor metadata, never the conversation/contact identity.
- Add a separate `group_message` SDK/event schema containing account/group/message IDs, sender UID/name, timestamp, `isSelf`, text, safe image/file attachments, quote, and mentions.
- Keep existing `group_activity` for group metadata/refresh only. `group_message` owns message persistence; old/new gateway overlap may refresh metadata once but never duplicate a Message.
- Dedupe durably by workspace + account + group + provider message ID across live events, reconnect overlap, BullMQ retention expiry, worker reclaim, and self echoes. Reject a missing provider message ID. A unique inbox-ledger row maps this identity to one immutable Message source ID and decides `isNew` before every realtime/automation effect.
- Persist actual sender and mentions under typed `contentAttributes.zaloAccount.group`; render/store no raw unbounded provider object.
- Reuse the existing controlled media path and same-group quote validation. Keep the one-text-or-one-attachment outbound boundary.
- Group persistence uses a dedicated side-effect-free facade and queues conversation realtime only after the ledger wins. It must not enter the direct `received-message` handler or emit customer-created, MAC/contact-activity, leaderboard, referral, commerce, or customer profile effects.
- Inbox send uses the canonical chat queue; the Zalo integration recognizes the reserved group conversation and calls the policy-checked group service with `ThreadType.Group`.
- Canonical outbound handlers apply an explicit `person | zaloAccountGroup` side-effect policy. Group Inbox/flow/API sends may persist Message/delivery/audit state but skip contact unblock/activity, MAC, human/bot analytics, leaderboard, and customer automation bookkeeping.
- `Contact.kind` is internal and not client-writeable. Generic Contact create always creates `person`; list/count/get/export/update/delete are person-only and return scoped not-found for a group anchor. Inbox receives a separate safe conversation audience discriminator from the group service.

## Files to modify/create

- `packages/database/src/partials/contact.ts`, `packages/database/src/schema/contact.ts`, `packages/database/src/schema/integration-zalo-account.ts`, a provider inbox-ledger schema/repository, relations/types/exports, purge coverage, and a generated migration.
- `packages/sdk/src/lib/zalo-account.ts` and SDK contract tests.
- `apps/zalo-account-gateway/src/runtime/{provider-message,ports,zca-client,zalo-account-runtime}.ts` and focused gateway tests.
- `packages/database/src/repositories/integration-zalo-account/group-repository.ts`.
- `packages/business/src/zalo-account/{group.service,group-inbox.service}.ts` and business tests.
- `apps/worker/src/events/zalo-account/handler.ts` plus a dedicated group-message handler/test; do not route through the direct `received-message` branch.
- `apps/worker/src/chat/handlers/{send-message,send-flow-step}.ts` and verified outbound bookkeeping/analytics consumers for the explicit group side-effect policy.
- `integrations/zalo-account/src/message.ts` and integration tests for direct/group outbound dispatch.
- Mandatory person-only Contact repository/service and public/private CRUD/resource entrypoints, including list/detail/count stats shortcut and writers, export, create/update/delete/quota release, `user-quota`, `workspace-usage`, broadcast audience builders, and every verified lead/customer scoring/direct repository caller.

## TDD sequence

### RED

1. SDK fixtures G-01–G-07: group text, self echo, account/group-scoped collision, mentions/fallback, quote, safe media, split provider IDs, and the `group_activity`/`group_message` compatibility matrix.
2. Gateway normalizer tests prove group content is preserved and direct normalization does not change.
3. Schema/service tests prove one anchor per group, DB default `person`, indexed FKs, row-locked/CAS provisioning, concurrent enable-vs-disable behavior, and retry-after-unique-conflict reuse.
4. Worker tests prove two senders land in one group conversation, keep distinct sender metadata, emit one realtime message, and create no member Contacts; crash/reclaim, late redelivery after BullMQ removal, and self echo before command result remain no-ops after the first commit.
5. Isolation tests prove group anchors are absent from public/private Contact list/detail/export/update/delete, the internal discriminator cannot be supplied on create/update, and anchors stay outside the no-filter O(1) stats count/writers, delete/quota release, broadcast materialization, contact quota/MAC reconciliation, lead/customer scoring, sequence enrollment, and contact-created analytics.
6. Outbound tests prove Inbox and flow text/image/file/reply sends use group policy/`ThreadType.Group`; direct messages still use `send_direct`, while group sends skip contact unblock/activity and customer analytics/automation side effects.

Run each test file alone with `VITEST_MAX_WORKERS=1`; confirm its expected failure before production changes.

### GREEN

1. Add the discriminator and group anchor FKs/indexes; register relations and purge coverage; generate then inspect migration SQL without applying it.
2. Add `ensureInboxAnchor`/`disableInboxAnchor` transaction methods in business/repository layers with a group-row lock or policy-version CAS. Never create anchors in gateway or app code; disable changes policy only.
3. Add the typed group message/mention/quote schemas and provider normalizer with bounded content; retain `group_activity` as metadata refresh and define deterministic fan-out/retirement behavior.
4. Publish fenced `group_message` events and enqueue a dedicated worker handler using stable scoped job IDs; treat queue IDs as optimization, not the durable dedupe boundary.
5. Insert/find the unique inbox-ledger identity and persist through a group-specific business facade that reuses only side-effect-free Message/Conversation/realtime primitives; emit downstream effects only when `isNew=true`.
6. Branch Zalo outbound dispatch by the reserved conversation source key, pass the typed group side-effect policy through shared chat handlers, and re-check account/group/send policy immediately before the command.
7. Make person-only behavior the default in the contact repository/service boundary, stats shortcut/writers, export, quota and deletion accounting; allow group-anchor access only through explicit group services. Audit every direct repository caller before migration approval.

### REFACTOR

- Share attachment/quote parsing between direct and group normalizers without creating a generic provider framework.
- Keep the direct event schema and direct worker branch unchanged.
- Consolidate customer exclusion into named predicates/helpers; do not scatter string comparisons through UI and workers.

## Focused verification order

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts __tests__/zalo-account-transport.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-message.test.ts __tests__/zalo-account-runtime.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-group.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-events.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run __tests__/message.test.ts
```

Run one line only after the previous line exits.

## Risks and stop conditions

- `Contact.kind` is safe only if every customer enumeration/count path is centrally guarded. Any unbounded audit gap blocks migration approval.
- Provider history/backfill is not part of this phase; durable dedupe still covers reconnect overlap and redelivery beyond BullMQ retention.
- Missing/unsupported message content is observable and skipped; it must not create an empty Inbox message.

## Success criteria

- [x] One group maps to one anchor and one conversation; no conversation per member.
- [ ] Sender/mention/reply/media identity survives end to end and self echoes dedupe.
- [x] Group anchors are invisible to every customer-only surface named above.
- [x] Inbox send works through the existing chat worker and group policy service.
- [x] Direct Zalo Account and Zalo OA regression tests remain unchanged/green.

## Rollback

Disable receive before send, keep anchor rows/history, and stop routing new `group_message` events. Do not drop schema automatically.
