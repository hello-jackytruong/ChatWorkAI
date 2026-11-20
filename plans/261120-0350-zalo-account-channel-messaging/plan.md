---
title: "Zalo Account channel and messaging"
description: "TDD plan for fenced transport, channel registration, direct messaging, controlled group sending, and native labels."
status: in-progress
priority: P1
effort: "XL"
tags: [zalo-account, channel-integration, websocket, messaging, tdd]
created: 2026-11-20
---

# Zalo Account channel and messaging (items 5–9)

## Overview

Continue from the completed [Zalo Account foundation](../261119-1534-zalo-account-foundation/plan.md) and make a personal Zalo account an operational ChatbotX channel. The gateway remains the only process that imports `zca-js` and owns WebSockets. It communicates through a typed, fenced Redis transport; accepted direct messages enter the existing integration worker; all durable reads/writes remain behind business services and repositories.

This plan covers exactly checklist items 5–9. It does not create a generic gateway framework, replace existing channel pipelines, or force Zalo groups into the 1:1 Contact/Inbox model.

Evidence: [ChatbotX scout](./reports/chatbotx-scout.md) and [ZaloCRM/provider reference](./reports/zalocrm-reference.md).

## Accepted scope and boundaries

| Item | Outcome | Boundary |
|---|---|---|
| 5 | Durable typed commands/events between application workers and gateway, protected by account lease fencing. | Never use the client realtime stream; gateway never writes message/Inbox tables. |
| 6 | Register `zaloAccount` as a visible, manageable channel with QR connect/session, Inbox binding, reconnect/disconnect, and safe projections. | Raw auth remains gateway-only and encrypted; public/private APIs call the same services. |
| 7 | Receive and send 1:1 text, reply/quote, image, and file messages through the existing Inbox pipeline, including own echoes and provider IDs. | No broad rich-message framework; unsupported provider payloads fail explicitly. |
| 8 | Discover/sync Zalo groups and allow controlled group sending through a provider-scoped resource. | `sendEnabled` defaults false; no fake Contact, Inbox conversation, flow automation, or generic group abstraction. |
| 9 | Synchronize Zalo native labels and attach/detach them for 1:1 contacts by reusing `TagChannel`/`ContactToTagChannel`. | Whole-document label writes are serialized per account; group labels never enter contact-tag rows. |

## Target flow

```text
Public API / UI / chat worker
        │ typed command + commandId
        ▼
durable command ingress / owner mailbox ──► selected gateway
                                      │ lease / target-fence check
                                      ▼
                              one zca-js socket owner
                                      │ atomic fence-check + event append
                                      ▼
dedicated Redis event stream ──► event consumer
        │ lifecycle/session             │ provider message
        ▼                               ▼
connection services             existing integration queue
                                      ▼
                      received-message / echo / group resource event
                                      ▼
                        existing Inbox, automation, realtime
```

## Phases

| # | Phase | Status | Depends on |
|---|---|---|---|
| 5 | [Fenced gateway transport](./phase-05-fenced-gateway-transport.md) | Pending | Foundation 1–4 |
| 6 | [Channel registration and Inbox lifecycle](./phase-06-channel-registration-and-inbox.md) | Pending | Phase 5; foundation migration applied with approval |
| 7 | [Direct messaging](./phase-07-direct-messaging.md) | Pending | Phase 6 |
| 8 | [Controlled group sending](./phase-08-group-control.md) | Pending | Phase 7; new migration applied with approval |
| 9 | [Native labels and tags](./phase-09-native-labels-and-tags.md) | Pending | Phase 7; Phase 8 group boundary |

## Sequencing and approval gates

1. Implement each phase in order; do not start the next phase until its focused regression gate passes.
2. Before Phase 6 database-backed integration tests, obtain explicit approval and apply the already-generated foundation migration. The plan itself must never run `db:migrate`.
3. Phase 8 may generate and inspect a migration for the group resource, but applying it requires a second explicit approval.
4. Phase 9 reuses existing tag tables and must not add schema unless a verified provider requirement makes it unavoidable; any such schema change requires replanning.
5. Roll out behind the existing gateway enablement plus a Zalo Account channel feature gate. Enable internal operators first, then a bounded workspace cohort.

## TDD and low-memory execution contract

Every behavior slice follows RED → GREEN → REFACTOR: add/tighten one focused test, run it and record the expected failure, implement the smallest production change, refactor while green, then rerun the focused workspace suite. Tests, installs, generators, lint, typecheck, and builds run **strictly one command at a time**. Do not use parallel agents for command execution and do not start concurrent Turbo/Vitest processes.

Focused pattern:

```bash
VITEST_MAX_WORKERS=1 pnpm --filter <workspace> exec vitest run <test-file>
```

If dependency linking is required, run this separately before verification:

```bash
CI=true pnpm install --no-frozen-lockfile
```

Final gates, in this exact order:

```bash
pnpm check:agent-instructions
pnpm check:invariants
pnpm turbo run lint --concurrency=1
pnpm exec ultracite check
pnpm check-types:cold
VITEST_MAX_WORKERS=1 pnpm turbo run test --concurrency=1
```

No command in the sequence may be backgrounded or overlapped with another command.

## Success criteria

- [ ] A stale/non-owner gateway cannot execute an account command, publish an accepted event, renew/release ownership, or mutate session state.
- [ ] Commands and events survive a consumer restart, are idempotent by stable IDs, and do not leak cookies, IMEI, user-agent, QR data, or decrypted auth.
- [ ] `zaloAccount` can be connected by QR, appears as an Inbox, reconnects/disconnects cleanly, and exposes only safe account metadata.
- [ ] 1:1 inbound/outbound messages use the canonical integration/chat pipeline; duplicates and own echoes do not create duplicate Inbox messages.
- [ ] Supported media are copied through controlled storage/validation; provider URLs and arbitrary local paths are not exposed to clients.
- [ ] Groups are discoverable and sendable only after explicit per-group enablement; dedicated group-resource events never enter the generic audience/direct-message handlers, create Contacts, or run direct-chat automation.
- [ ] Native labels synchronize with `TagChannel`, attach/detach without lost whole-document updates, and remain scoped to the owning workspace/account.
- [ ] Public API, CLI, MCP, UI, worker, gateway, and documentation expose the same supported operations and failure semantics.
- [ ] All focused and repository quality gates pass sequentially with one worker/concurrency.

## Non-goals

- Broadcasts, flow steps, group Inbox conversations, group automations, history backfill, voice/video/sticker/card/poll/forward/reaction actions, full group administration, or a cross-provider group/label framework.
- Reusing Zalo OA credentials/endpoints or changing the existing Zalo OA integration.
- Automatic retry of a non-idempotent send after an ambiguous provider outcome.
- Applying database migrations, deploying, enabling a production cohort, or committing/pushing as part of this planning task.

## Rollback

Disable the Zalo Account channel gate, stop/revoke gateway runtimes, and leave existing channel pipelines untouched. Transport consumers can be stopped after draining/acknowledging accepted entries. For schema phases, roll back application behavior before considering schema removal; never drop encrypted account/group data without a separate retention decision.

## Load-bearing assumptions

- Pinned `zca-js` 2.1.2 remains the compatibility target; static types/source prove the planned direct-message, group, and label operations, but staging must validate real payloads before rollout.
- The account lease store can expose an atomic compare-fence-and-append operation on the deployed Redis topology; plain consumer-time validation is insufficient. If Redis Cluster is introduced, lease and fenced outbox keys must share a hash slot or use a proven equivalent.
- Zalo native labels are an account-wide versioned document, so label mutations must be serialized and conflict-aware.
- Existing 1:1 Inbox semantics remain unchanged; groups intentionally use `ChannelAudienceEvent` plus a provider resource.

## Validation Log

### 2026-11-20 — Hard-mode plan verification

- CLI validation passed; task projection reports 5 phases and 36 pending tasks.
- Claims were checked against the current gateway, lease store, event bus, integration queue, registries, message persistence, group audience handler, tag services, and pinned `zca-js` 2.1.2 source evidence. Planning ran no build/test/lint process.
- Independent reviews: [security](./reports/red-team-security.md), [assumptions/contracts](./reports/red-team-assumptions.md), and [failure modes](./reports/red-team-failure-modes.md).
- Accepted amendments include owner mailboxes instead of fake broadcast, immutable tenant route scope, atomic fencing, encrypted one-time QR/auth delivery, trusted QR handoff, fail-closed teardown/media, durable idempotency, dedicated no-contact group events, complete sync generations, label conflict gates, startup reconciliation, bounded poison/retention/shutdown, and provider-wide backoff.
- Out of scope after review: true group Inbox/participants, full group administration, indefinite history replay without evidence, and cross-provider gateway/group/label frameworks.
- Live-account fixtures remain a rollout gate for label conflict behavior and exact group/message payloads; static evidence is enough to plan, not enable production.

### Whole-plan consistency sweep

- Re-read `plan.md`, five phase files, two research reports, and three red-team reports.
- Replaced generic audience routing with a dedicated no-contact group resource path.
- Reconciled low-memory gates with repository wrappers; all commands remain sequential and Turbo/Vitest concurrency is one.
- Remaining implementation risks are explicit stop signals or migration approval gates.

<!-- slug: zalo-account-channel-messaging -->
