# Zalo Account P0.4 — send integrity/recovery research

Research date: 2026-11-23
Scope: `docs/zalo-account-checklist.md` P0 · 4 only. This is a read-only
implementation-plan report; no code or tests were changed or run.

## Result

The existing design already has the important write-safety boundary: a scoped
send attempt is claimed before provider dispatch, a provider write that might
have happened becomes durable `unknown`, and unknown writes are not replayed.
The TDD work should extend the existing send-attempt row, group message
identity, and shared outgoing-source reconciliation. A new identity ledger or
new queue is not justified.

The highest-risk gaps are:

1. Provider client IDs (`cliMsgId`) are normalized on inbound events but never
   written to or queried from send attempts. The schema already has
   `providerClientMessageIds`, so this is an unused existing contract rather
   than a missing table.
2. The generic worker reconciliation assigns only the first provider ID. A
   text-plus-image command can return multiple IDs; the remaining own echoes
   are not reconciled through the shared helper.
3. Group own-echo lookup only uses `providerMessageIds`. If an echo arrives
   before the gateway callback confirms the attempt, the group identity is
   allocated with a new Message identity and no later code rebinds it to the
   prepared outgoing Message.
4. Unsupported normalized payloads are intentionally dropped after optional
   group-activity refresh. The runtime callback is a no-op, so the checklist's
   placeholder and unsupported/error/missing-identity metrics are not present.
5. Group rate limiting is distributed and has account/group buckets, but direct
   sends have no equivalent per-account send bucket. Admission and rate-limit
   failures expose a human-readable string, not structured `retryAfter` or
   cooldown metadata.

## Existing guarantees and call paths

### Send callers

- Public direct API `POST /v1/zalo-accounts/{accountId}/messages` and public
  group API call `zaloAccountCanonicalSendService.send`
  (`apps/builder/src/features/zalo-accounts/api/operations.ts:275-327`,
  `apps/builder/src/features/zalo-accounts/api/public.ts:280-302`). The service
  validates the known target, creates a pending attempt and stable local
  Message before enqueueing the existing chat worker
  (`packages/business/src/zalo-account/canonical-send.service.ts:252-365`).
- The Inbox path and all normal worker sends call the integration's
  `sendMessage`; flow steps call `sendFlowStep`. Both converge on
  `sendRoutedMessage` (`integrations/zalo-account/src/message.ts:61-118` and
  `:181-302`). Direct sends use
  `zaloAccountSendAttemptService.send`; group sends use
  `zaloAccountGroupService.sendByProviderId`, which delegates to the same
  send-attempt service (`packages/business/src/zalo-account/group.service.ts:201-220,
  :423-481`).
- Flow sends require a persisted idempotency key and use it as the command ID
  (`integrations/zalo-account/src/message.ts:230-302`). Existing adapter tests
  cover the group route and distinct API/flow command identities
  (`integrations/zalo-account/__tests__/message.test.ts:49-92,135-200`).

### Claim, fence, and unknown outcome behavior

- The scoped command ID hashes workspace, account, thread type/thread ID and
  caller command ID (`packages/business/src/zalo-account/send-attempt.service.ts:52-58`).
  `claim` inserts the attempt before dispatch, with a unique
  `(workspaceId, accountId, commandId)` key, and prepared API work is recovered
  only while `pending`, undispatched and younger than one hour
  (`packages/database/src/repositories/integration-zalo-account/send-attempt-repository.ts:83-139`,
  `packages/business/src/zalo-account/canonical-send.service.ts:113-129`).
- A failed pre-dispatch check is `failed`; any other send exception is settled
  `unknown`, and `unknownOutcome` is explicitly non-retryable
  (`packages/business/src/zalo-account/send-attempt.service.ts:15-21,149-180`).
  `assertCanResend` blocks pending/unknown/applied attempts by local Message
  identity (`:60-71`), and the worker catch path records a send error without
  BullMQ replay for a Zalo send with an unresolved/accepted attempt
  (`apps/worker/src/chat/handlers/send-message.ts:694-724`).
- The gateway command envelope carries expiry and an owner/fence target. The
  executor rejects stale owners/fences before dispatch, claims a Redis state key
  with `NX`, and returns the saved outcome for a duplicate command
  (`apps/zalo-account-gateway/src/transport/command-executor.ts:116-165`).
  Non-pre-dispatch failures are `unknown` for `send_direct`, `send_group` and
  `update_labels`; other operations are `failed` (`:167-192`).
- Redis consumer reclaim is bounded: 30-second idle reclaim, 20-entry batches,
  five maximum deliveries, and a 10,000-entry DLQ. Result keys are retained for
  24 hours, and a failed result write leaves the stream entry pending for
  another owner (`apps/zalo-account-gateway/src/transport/redis-command-consumer.ts:49-75,157-187,242-279,311-346`).
  The command stream enqueue has a hard 10,000-entry capacity and owner mailbox
  expiry is 24 hours (`packages/business/src/zalo-account/transport.service.ts:19-29,590-603`).
- The transport waits up to its caller-supplied timeout (send callers use 30
  seconds) and turns missing/unknown results into “do not retry automatically”
  errors (`packages/business/src/zalo-account/transport.service.ts:284-331,556-588`).
  This is intentionally different from a normal read retry policy and should
  be preserved while making the read/write classification explicit.

### Provider identity and echo handling

- The provider normalizer retains `msgId` as `providerMessageId`, `cliMsgId` as
  `clientMessageId`, thread, sender/recipient, timestamp, `msgType`, self flag,
  quote and supported attachments (`apps/zalo-account-gateway/src/runtime/provider-message.ts:157-199,212-265`).
  Direct integration persistence carries those fields in
  `contentAttributes.zaloAccount` (`integrations/zalo-account/src/message.ts:130-178`),
  and tests prove direct/group `msgId` + `cliMsgId` retention
  (`apps/zalo-account-gateway/__tests__/provider-message.test.ts:23-51,99-120`).
- The database attempt model already declares both ID arrays and a GIN index for
  provider message IDs (`packages/database/src/schema/zalo-account-message-state.ts:131-184`),
  but `send-attempt-repository.settle` accepts only `providerMessageIds` and
  `findByProviderMessage` queries only that array
  (`packages/database/src/repositories/integration-zalo-account/send-attempt-repository.ts:194-238`).
  `providerClientMessageIds` currently has no production read/write path; the
  database test only verifies its empty default
  (`packages/database/__tests__/integration/zalo-account-group-operations.test.ts:302-329`).
- The gateway's `zca-js` adapter returns the text message ID plus attachment
  message IDs (`apps/zalo-account-gateway/src/runtime/zca-client.ts:187-207,265-285`),
  but does not return client IDs. The pool confirms the attempt using those
  provider IDs before returning the command result (`apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts:136-163,199-237`; callback wiring:
  `apps/zalo-account-gateway/src/main.ts:56-60`).
- The shared worker helper already handles the important one-ID race: it calls
  `messageService.reconcileOutgoingSourceId`, merges the echo and emits
  `messageRemoved` for a duplicate (`apps/worker/src/chat/handlers/send-message.ts:1379-1438`).
  The regression test at `apps/worker/__tests__/send-message-handler.test.ts:736-776`
  proves an echo that arrived before the send result is removed. However, the
  helper takes `result.messageIds[0]` only (`:1385-1403`), so it does not cover
  the remaining IDs from a multi-message provider response.
- Group persistence uses a separate existing durable identity table keyed by
  account/group/provider message ID (`packages/database/src/schema/zalo-account-message-identity.ts:22-71`).
  It can reuse the attempt's local Message only when `findByProviderMessage`
  sees an applied attempt; otherwise it creates a new stable identity
  (`packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:87-141`).
  The later transaction only invokes the shared reconciler when that local
  identity already equals the attempt Message (`:184-196`). Therefore an
  own-echo-before-confirm race leaves the early identity detached from the
  outgoing Message. Recovery requeues pending identities in bounded batches,
  but does not add an alias/rebind step (`:283-329`; scheduler test:
  `apps/worker/__tests__/zalo-account-group-recovery.test.ts:30-80`).

## Actual gaps mapped to P0.4

| Checklist item | Evidence | Assessment for the plan |
| --- | --- | --- |
| All sends use canonical send | Existing text/image/file Inbox, flow, direct API and group API converge on `sendRoutedMessage`; unsupported types fail explicitly (`integrations/zalo-account/src/message.ts:181-302`, `docs/zalo-account.md:108-131`). | Existing paths are covered. Add contract tests so a future send type cannot bypass the attempt service; do not add another send route now. |
| API result ↔ own echo; one command → many IDs | Runtime returns text + attachment IDs, but worker reconciles only first; group lookup is provider-ID-only and races before confirmation (`zca-client.ts:203-207`; `send-message.ts:1387-1403`; group repository above). | Highest priority. Extend existing alias/reconciliation primitives, not a new ledger. |
| Retain `msgId`, `cliMsgId`, scope, timestamp, type | Normalized inbound data retains all fields, but the send attempt only persists provider IDs; client IDs are dropped from attempt correlation (`provider-message.ts:212-265`; `send-attempt-repository.ts:194-238`). | Persist/query the existing client-ID array and preserve normalized metadata in the existing message attributes. |
| Duplicate, out-of-order, late, echo-before-result | Provider job IDs hash account/thread/provider ID and group identity has a unique scope key (`apps/worker/src/events/zalo-account/handler.ts:139-188`; identity schema above). The single-ID direct race is covered, group early echo is not. | Add direct multi-ID and group pre-confirm/recovery tests; retain current unique keys and bounded recovery. |
| Unsupported payload placeholder + metadata | Normalizer returns `unsupported`; runtime only refreshes group activity and invokes a no-op callback (`provider-message.ts:212-243`; `zalo-account-runtime.ts:450-475`). | Add a typed placeholder/metadata route and metric tests, with bounded selected fields only. Do not retain raw provider payloads. |
| Unsupported/error/missing-identity metrics | No metric call is made by the no-op unsupported callback; missing identity is just a reason string (`zalo-account-runtime.ts:471-475`; `provider-message.ts:217-243`). | Add counters at the gateway boundary, tagged by reason/thread type, without changing other channels. |
| Schema/version retention | Transport commands/events are version 1 (`packages/sdk/src/lib/zalo-account.ts:198-203,711-718`), while normalized message objects have no message-normalizer version field (`:228-281`). | Preserve transport v1 compatibility; decide whether a small normalized metadata version is required before implementation and test old/new parses. |
| Account/group rate limit + `retryAfter`/cooldown | Group bucket is atomic Redis time, 60 account/minute plus 10 per group/minute (`packages/business/src/zalo-account/group-rate-limit.ts:4-49`). Gateway circuit is in-memory, 3 account failures/15s or 5 provider failures/30s by default, and returns only a number that is interpolated into an error string (`apps/zalo-account-gateway/src/transport/provider-admission.ts:21-87`; executor `:141-155`). Direct sends have no comparable token bucket. | Expose structured delay metadata and add direct account admission; keep group rates and avoid retrying a dispatched write. |
| Read retry vs write-may-have-applied | Executor marks non-pre-dispatch send/group/label writes unknown; other operation failures are failed (`command-executor.ts:167-192`). | Safety is present but implicit. Add a command-kind matrix test and explicit retry metadata; never copy automatic write retry. |

## TDD RED scenarios and smallest likely change surfaces

Write the following failing tests before implementation, then make the smallest
existing-boundary change that satisfies them:

1. **Direct text + image, all IDs.** A send result containing two provider IDs
   must retain both. Deliver each own echo before and after the result, including
   duplicate/out-of-order deliveries; the canonical outgoing Message remains
   one message, its attachment/source metadata is complete, and each duplicate
   is removed/reconciled. Start in
   `apps/worker/__tests__/send-message-handler.test.ts` beside the existing
   pre-result test, then add the repository/service assertion in
   `packages/business/__tests__/zalo-account-send-attempt.service.test.ts`.
2. **Client-ID correlation.** A normalized own echo with `clientMessageId`
   arriving before confirmation may be retained as bounded metadata, but that
   client ID alone cannot prove which pending attempt produced it. Only after a
   known provider result (or another deterministic provider identity) may it be
   associated with the scoped attempt. Duplicate aliases must be harmless; an
   alias from another account/thread must not match. Add RED coverage to
   `packages/database/src/repositories/integration-zalo-account/send-attempt-repository.ts`
   tests (or the existing database integration suite) and
   `apps/zalo-account-gateway/__tests__/provider-message.test.ts`.
3. **Group echo before result.** Insert a self group echo before
   `confirm()`, confirm a result with one or several provider IDs, then replay
   the echo and run bounded recovery. The early identity must resolve to the
   prepared local Message, not a second Message. Cover the existing group
   repository transaction path in the database integration suite and the
   recovery scheduler test; do not add another identity table.
4. **Late/duplicate jobs.** Re-deliver the same direct and group provider event
   and prove the existing job IDs/unique source identities make persistence
   idempotent. Include a stale policy/fence event and verify it cannot write or
   trigger a send (`apps/worker/src/events/zalo-account/handler.ts:139-188`,
   `apps/zalo-account-gateway/__tests__/command-executor.test.ts:149-212`).
5. **Unknown writes never replay.** Preserve existing tests for pending/unknown
   command claims and transport timeouts, and add the API/flow paths so a
   timeout followed by a caller retry returns the durable attempt state rather
   than dispatching again (`packages/business/__tests__/zalo-account-send-attempt.service.test.ts:87-119`,
   `apps/zalo-account-gateway/__tests__/command-executor.test.ts:204-287`,
   `integrations/zalo-account/__tests__/message.test.ts:135-200`).
6. **Rate metadata and classification.** Assert group account/group bucket
   exhaustion, direct account exhaustion, positive `retryAfterMs`, cooldown
   expiry, pre-dispatch `failed`, and post-dispatch `unknown`. Extend
   `apps/zalo-account-gateway/__tests__/provider-admission.test.ts:4-37`,
   `apps/zalo-account-gateway/__tests__/command-executor.test.ts:214-287`, and
   add focused business rate-limit tests without starting Redis or a gateway.
7. **Unsupported payload observability.** Normalize missing identity, malformed
   fields and unsupported content; assert a safe placeholder/selected metadata
   outcome and reason counter, with no raw payload/cookie leakage. Existing
   normalizer coverage starts at
   `apps/zalo-account-gateway/__tests__/provider-message.test.ts:123-209`.
8. **Schema compatibility.** Parse transport/message fixtures at version 1 and
   verify new optional identity metadata does not reject old stored messages.
   Keep this Zalo-specific and do not alter other channel message schemas.

### Minimal implementation shape to validate in the plan

- Extend `zaloAccountSendAttemptRepository.settle`/`findByProviderMessage` and
  the existing `providerClientMessageIds` column; make `confirm` idempotently
  merge bounded provider/client IDs. Do not create a new identity ledger.
- Reuse `messageService.reconcileOutgoingSourceId` and its transaction/lock
  behavior. If multiple aliases require a list, add an opt-in Zalo path or a
  list-aware primitive whose default behavior is unchanged for every other
  channel. It must reconcile all returned provider IDs to the same canonical
  Message rather than repeatedly replacing its source ID.
- Teach group persistence/recovery to retain an early self echo in the existing
  identity row without claiming it belongs to an attempt from `cliMsgId` alone;
  once a known provider result deterministically links the attempt, rebind to
  the attempt's stable Message ID and invoke the shared reconciler. Keep the
  existing group identity unique key and bounded `pickPending` recovery.
- Carry structured `retryAfterMs`/cooldown and operation classification through
  the existing typed outcome/error contract. Group admission is already
  pre-dispatch; direct admission should be added at the same boundary. Never
  turn an ambiguous write into an automatic retry.
- Add unsupported counters/placeholder metadata at the gateway event boundary;
  retain only bounded normalized fields and the existing event `version: 1`.

## Resource budgets and verification commands

Keep tests deterministic and unit/transaction-focused. Existing limits to honor:

- command stream and DLQ: 10,000 entries; owner mailbox/result/state TTL: 24h;
  consumer batch 20; reclaim idle 30s; max deliveries 5; command payload 256
  KiB (`transport.service.ts:19-29`, `redis-command-consumer.ts:49-75,242-346`);
- API prepared recovery: 50 requested / 100 repository cap; API wait 30s with
  250ms polls (`canonical-send.service.ts:366-390`; repository `:141-170`);
- transport result wait: caller send timeout 30s with 50ms polls
  (`transport.service.ts:321-331,556-588`);
- group buckets: 60 account/minute and 10 group/minute; attachment preparation
  10 MiB image / 25 MiB file and 30s abort
  (`group-rate-limit.ts:28-49`; `canonical-send.service.ts:185-228`).

Relevant narrow commands after implementation (do not run broad suites for this
research task):

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-canonical-send.test.ts __tests__/zalo-account-send-attempt.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/command-executor.test.ts __tests__/redis-command-consumer.test.ts __tests__/provider-admission.test.ts __tests__/provider-message.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run __tests__/message.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/send-message-handler.test.ts __tests__/zalo-account-group-recovery.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec dotenv -e ../../.env -- vitest run __tests__/integration/zalo-account-group-operations.test.ts
```

The database command is opt-in and requires configured infrastructure; use it
only for the transaction/identity RED cases. Do not run `pnpm test`, cold
typechecks, or gateway/integration end-to-end suites as part of the initial
TDD loop.

## Comparison-only source: ZaloCRM

`/Volumes/DevSSD/Work/GitHub/ZaloCRM/backend/src/shared/zalo-operations.ts:176-239`
checks operation-category rate limits and retries a zca call up to three times
for session expiry or transient socket errors, including a reconnect. That is
useful evidence for separating read retry policy and surfacing rate metadata,
but it is unsafe as a direct model for ChatbotX writes: a send can have reached
Zalo before a socket error. ChatbotX's pre-dispatch claim, fenced command,
durable attempt and `unknown` no-replay behavior are the stronger guarantee and
must remain authoritative.

## Limitations / unresolved decisions

- `zca-js` send results exposed by the adapter provide `msgId` values but no
  client IDs; the implementation plan must decide whether client aliases come
  only from own echoes or whether the provider call can supply a deterministic
  client ID. Do not infer equality between caller `commandId` and provider
  `cliMsgId`.
- The checklist requests a bubble placeholder and metrics, but product-facing
  placeholder copy/metric backend is not defined in the reviewed sources. The
  plan should select the existing project observability/Inbox event owner before
  coding, while keeping raw provider data out.
- No broad socket/media/archive/undo work was assessed. Other channels must keep
  their current source reconciliation behavior.

Status: DONE_WITH_CONCERNS
Summary: Existing command fencing, durable attempts, no-replay unknown outcomes, and one-ID echo reconciliation are sound. TDD should focus on multi-ID/client-ID alias retention, group echo-before-confirm rebinding, structured rate metadata/direct admission, and unsupported observability while reusing existing identity/reconciliation primitives.
Concerns/Blockers: Provider client-ID semantics are not exposed by the current zca adapter, and the placeholder/metric sink is not specified; implementation needs an explicit bounded choice for those two contracts.
