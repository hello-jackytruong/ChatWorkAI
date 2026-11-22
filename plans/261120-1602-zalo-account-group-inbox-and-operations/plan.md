---
title: "Zalo Account group Inbox and operations"
description: "TDD delta plan for checklist items 10–16: full group Inbox, group controls, native labels, lifecycle events, agent-first APIs, admin UI, and sequential quality gates."
status: in-progress
priority: P1
effort: "XL"
branch: dev
tags: [feature, zalo-account, inbox, websocket, api, tdd]
blockedBy: ["261120-0350-zalo-account-channel-messaging"]
created: 2026-11-20
---

# Zalo Account group Inbox and operations (items 10–16)

## Overview

Extend the implemented Zalo Account foundation and items 5–9 without replacing their fenced gateway, direct-message path, group resource, label mapping, or connection engine. The new work adds a controlled group Inbox and the remaining operational surfaces while keeping Zalo OA and every existing channel unchanged.

Evidence: [ChatbotX gap analysis](./reports/chatbotx-gap-analysis.md) and [provider/ZaloCRM analysis](./reports/provider-and-reference-analysis.md).

## Scope lock

| Item | Required outcome | Existing baseline kept |
|---|---|---|
| 10 | One Inbox conversation per enabled group; actual sender, mentions, replies, attachments, self echoes, and realtime. | `IntegrationZaloAccountGroup`, fenced transport, direct Inbox pipeline. |
| 11 | Receive/send/automation controls, allowlist, mention-only mode, kill switch, limits, and audit. | Disabled-by-default group send policy and provider admission circuit. |
| 12 | Safe ChatbotX Tag ↔ Zalo native-label reconciliation for direct and group threads. | `TagChannel`, `ContactToTagChannel`, versioned whole-document mutation. |
| 13 | Durable lifecycle, delivered/seen, typing, reactions, undo/revoke, and conditionally supported delete. | Direct delivered/read and undo handlers plus low-priority bookkeeping queue. |
| 14 | Public API first, then generated CLI/MCP parity for lifecycle, sync, policy, send, and reconciliation. | Existing connections API and current group/label public routes. |
| 15 | Operational admin UI and group Inbox presentation with i18n. | Existing QR/connect and Zalo Account settings page. |
| 16 | Sequential TDD, regression, migration, security, and rollout gates. | Existing unit/contract tests and repository invariants. |

HOLD SCOPE. Do not add broad group administration, rich-media parity, a cross-provider group framework, or history/member backfill beyond what items 10–16 require.

## Architecture decision

Use the existing Conversation/Message/ContactInbox substrate through an explicitly discriminated group anchor:

1. `IntegrationZaloAccountGroup` remains the provider metadata and policy source of truth.
2. Enabling group receive OR send provisions exactly one `Contact(kind=channelGroup)`, one `ContactInbox`, and one Conversation with a reserved group source key. A row-locked/CAS group-policy transaction owns anchor creation, stores both references, and reuses the uniqueness winner on retries; disabling retains the anchor/history. User decision on 2026-11-21: send-only groups have an anchor for outbound persistence while `receiveEnabled=false` continues to reject all incoming messages.
3. Group messages use a new Zalo-specific SDK event family. The group ID identifies the conversation; `senderId`/`senderName`/mentions live in message content attributes. No Contact is created per member. A durable unique inbound identity `(workspace, account, group, providerMessageId)` decides `isNew` before Message, realtime, or automation effects.
4. Group anchors are excluded at mandatory person-only repository/service boundaries, including stats writers/shortcuts, export, broadcast, contact quota/MAC, lead/customer analytics, sequences, and deletion/release paths—not by UI filtering alone.
5. Inbox send reuses the canonical chat worker but the Zalo integration recognizes the reserved group conversation key and calls the existing policy-checked group service. Direct sends remain on their current path.
6. Group automation carries a typed, durable `zaloAccountGroup` audience through enqueue, retry, Wait/resume, and action scope. A deny-by-default allowlist is checked both before enqueue and before execution; only group reply sends and add/remove tag are allowed.
7. Every group event/job/command carries a policy epoch. Workers and provider admission re-read the epoch immediately before persistence/send so a kill switch fences already-queued work without stopping direct traffic.

This is narrower than a separate group-thread/message platform and safer than treating every member as a Contact. If isolation tests cannot prove that `channelGroup` anchors stay out of customer surfaces, stop and replan before migration approval.

## Phases

| # | Phase | Status | Depends on |
|---|---|---|---|
| 10 | [Full group Inbox](./phase-10-full-group-inbox.md) | Completed; core staging send/receive/media verified | Items 1–9; migration approval before DB application |
| 11 | [Group controls and automation policy](./phase-11-group-controls.md) | Completed (static verified) | Phase 10 |
| 12 | [Native labels and group tags](./phase-12-native-labels-and-group-tags.md) | Completed (static verified) | Phases 10–11 |
| 13 | [Advanced message lifecycle](./phase-13-advanced-message-lifecycle.md) | Completed (static verified) | Phase 10 |
| 14 | [Public API, CLI, and MCP](./phase-14-public-api-cli-mcp.md) | Completed; API and built CLI/MCP verified on staging | Phases 11–13 |
| 15 | [Admin UI and Inbox presentation](./phase-15-admin-ui-and-inbox.md) | Completed (static verified) | Phase 14 |
| 16 | [Sequential verification and rollout](./phase-16-sequential-quality-gates.md) | All repository gates passed; final lifecycle observation pending | Phases 10–15 |

All phases execute in this order. No implementation phase runs in parallel because schema, SDK contracts, worker routing, and generated API surfaces are shared.

## TDD and low-memory execution contract

Execution update from the user (2026-11-21): allow **at most 3 Vitest workers** (`VITEST_MAX_WORKERS=3`), while every command remains sequential and Turbo stays `--concurrency=1`. Finish implementation before full tests; run lint after full tests pass. This supersedes the original one-worker examples and final-gate order below; one worker remains a valid lower-memory choice.

Every slice follows RED → GREEN → REFACTOR. Before production code, add one focused behavior test and run it to record the expected failure. Implement only enough to pass, refactor while green, then rerun that focused workspace suite.

Every install, generator, lint, typecheck, test, build, migration inspection, and live-fixture command runs **strictly one command at a time**. Do not background commands, start a second Vitest/Turbo process, or use parallel agents to execute commands. Use `VITEST_MAX_WORKERS=1` and Turbo `--concurrency=1` wherever applicable.

Focused pattern:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter <workspace> exec vitest run <test-file>
```

Migration generation is allowed only after schema tests are green:

```bash
pnpm --filter @chatbotx.io/database make:migration zalo-account-group-inbox
```

Read and diff the generated SQL/snapshot. Never run `db:migrate` without a separate explicit approval from the user.

## Acceptance criteria

Checked items have source/contract/unit/static verification. Migration approval/application, real anchor contention and built CLI/MCP checks have now passed on the approved staging workspace. Live observations and remaining lifecycle limits are recorded in the private staging records (not included in this repository).

- [x] Each receive-enabled group has exactly one Inbox conversation; messages from different members do not create member Contacts or extra conversations.
- [x] Group sender UID/name, mentions, reply IDs, supported image/file attachments, self echoes, and scoped dedupe survive WebSocket → gateway → worker → Message → realtime.
- [x] Truncated/partial provider snapshots never tombstone groups or labels; only a fenced, proven-complete snapshot may mark missing rows inaccessible.
- [x] New group/account policies default off and block receive, send, and automation independently; mention-only checks the connected account UID in provider mention spans.
- [x] Group anchors never appear in customer CRM lists, broadcasts, contact quota/MAC, lead/customer scoring, sequences, or customer-only automation.
- [x] Direct messages, Zalo OA, and all other channels preserve current behavior and contracts.
- [x] Native label writes are serialized, version/conflict safe, non-destructive under incomplete/stale snapshots, and work for direct and group-thread tag assignments.
- [ ] Ambiguous outbound sends persist a durable `unknown` attempt and reconcile from self echo/provider IDs without automatic replay.
- [x] Durable status/reaction/undo events converge under duplicate and out-of-order delivery; typing is ephemeral; unsupported delete remains unavailable rather than guessed.
- [x] Public API, generated CLI, MCP, private UI, and Inbox all call the same business services and expose no authorization/session secrets.
- [ ] All focused and repository gates pass sequentially with one worker/concurrency, and live provider fixtures gate production enablement.

## Non-goals

- Group creation/rename/member/admin/moderation operations, bulk/all-group sends, full member roster persistence, unbounded history backfill, or importing group members as customers.
- Sticker, voice, video, GIF, album, card, poll, forward, or edit-message parity.
- Reaction-triggered automation, group broadcasts, cross-provider group abstractions, or changes to the existing Zalo OA integration.
- Applying migrations, deploying, enabling production accounts, committing, pushing, or merging as part of this planning task.

## Approval and stop gates

1. Generate and inspect migrations only. Applying any Zalo Account migration requires explicit approval.
2. Production group receive/send stays disabled until pinned fixtures G-01–G-17 and bounded live-account gates pass.
3. If provider sync cannot prove completeness, keep missing groups/labels/members unchanged and mark the sync partial.
4. If provider delete/revoke behavior is not stable in live validation, ship inbound undo only and keep outbound delete unavailable.
5. If `channelGroup` exclusion requires scattered, untestable exceptions instead of central guards, stop and replan a native group-thread model.

## Rollback

Turn off the account group kill switch, advance its policy epoch, and park/cancel delayed group jobs. Workers and provider admission reject stale epochs before persistence/send while direct account events continue. Then drain in-flight group work and set `receiveEnabled=false`, `sendEnabled=false`, and `automationMode=disabled` for all groups. Preserve group anchors/messages and durable reconciliation records for audit and recovery; do not delete schema or encrypted account data without a separate retention decision.

## Load-bearing assumptions

- Pinned `zca-js` 2.1.2 event fields match staging payloads for the target account/device configuration. Static types are planning evidence, not production approval.
- A dedicated group persistence facade can reuse side-effect-free Message/Conversation/realtime primitives without entering the direct `received-message` path. Phase 10 isolation tests must prove every person-only boundary, including stats and quota reconciliation; otherwise stop and replan.
- Provider message identity remains `account + group + msgId`; missing `msgId` is rejected, while missing `cliMsgId` disables revoke but not persistence.
- Whole-label responses expose a usable accepted version. If not, label mutation remains read-only.

## Red Team Review

Four read-only reviewers checked the plan against current source contracts. All 20 findings were accepted; overlapping findings were consolidated into the owning phase rather than creating extra scope.

| Report | Findings | Applied corrections |
|---|---:|---|
| [Assumptions](./reports/red-team-assumptions.md) | 5 High | Mandatory person-only boundaries, side-effect-free group facade, typed automation audience, durable label state, crash-safe friend quota accounting. |
| [Failure modes](./reports/red-team-failure-modes.md) | 1 Critical, 4 High | Completeness proof, anchor serialization, durable dedupe ledger, unknown-send reconciliation, policy-epoch rollback fencing. |
| [Security](./reports/red-team-security.md) | 5 High | Private-action permission checks, stats isolation, deny-by-default automation, partial-sync safety, account-inclusive lifecycle identity. |
| [Contract/scope](./reports/red-team-contract-scope.md) | 3 High, 2 Medium | Outbound side-effect policy, typing compatibility matrix, Contact public CRUD boundary, group event coexistence, distinct CLI/MCP policy names. |

No finding required reversing an explicit user decision or expanding beyond checklist items 10–16.

## Validation Log

- Full-tier evidence review completed against both ChatbotX and the reference ZaloCRM/provider behavior reports.
- Cross-phase consistency sweep resolved ownership for schema, gateway events, durable dedupe, policy/audience context, label reconciliation, public operations, UI, and rollout.
- `ak plan validate plans/261120-1602-zalo-account-group-inbox-and-operations --json`: valid, zero structural errors.
- Execution remains seven strictly ordered phases and all build/test/generator/migration-inspection commands remain foreground, single-worker/single-concurrency.

<!-- slug: zalo-account-group-inbox-and-operations -->
