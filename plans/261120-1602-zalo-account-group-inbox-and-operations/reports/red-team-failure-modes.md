# Red-team failure modes

Scope: adversarial review of `plan.md` and phases 10–16 against the current
Zalo Account gateway, worker, queue, label, sync, lifecycle, and purge paths in
this checkout. No build, lint, test, install, migration, or generator command
was run. The findings below are limited to Critical/High/Medium planning risks.

## 1. Critical — a truncated group sync can tombstone valid groups

**Location:** `phase-10-full-group-inbox.md:18-23,55-60`,
`phase-11-group-controls.md:18-20`, `plan.md:103-106`; current provider and
sync paths at `apps/zalo-account-gateway/src/runtime/zca-client.ts:132-155`,
`packages/business/src/zalo-account/group.service.ts:46-81`, and
`packages/database/src/repositories/integration-zalo-account/group-repository.ts:94-117`.

**Scenario:** `getAllGroups()` returns more than 1,000 IDs, `getGroupInfo()`
returns a partial map, or a detail request is rate-limited. The adapter still
returns a plain `ZaloAccountGroup[]`; the business service then unconditionally
calls `finishCompleteSync`. Every previously known row absent from that partial
array is marked inaccessible and `sendEnabled=false`. A transient provider
failure therefore turns healthy groups off and can also make receive-anchor
state appear removed.

**Evidence:** `zca-client.ts:133-142` hard-caps IDs and skips missing details;
there is no complete/page/result marker. `group.service.ts:60-80` always uses
the command ID as a sync run and finishes it as complete. The repository update
at `group-repository.ts:103-116` tombstones every row whose run ID differs.
The plan says partial results must preserve missing rows, but it does not make
the provider result carry proof that this path can consume.

**Required fix:** Return a typed sync result with `complete`, reason, cursor or
provider total, and detail-page status. Treat the 1,000-ID cap, missing detail,
timeout, and any unknown completeness as partial; persist the run as partial and
leave existing rows/policies/anchors unchanged. Call `finishCompleteSync` only
after a proven complete snapshot, and fence stale run completions from newer
runs. Add a test for a truncated `gridVerMap` and a missing detail response,
not only an ordered list of successful groups.

## 2. High — anchor enable/disable races can leave dangling or failed anchors

**Location:** `phase-10-full-group-inbox.md:18-21,46,55-60`,
`phase-11-group-controls.md:18-23,51-55`; current identity constraints at
`packages/database/src/schema/integration-zalo-account.ts:81-87`,
`packages/database/src/schema/contact-inbox.ts:185-204`, and
`packages/database/src/schema/conversation.ts:82-89`.

**Scenario:** Two policy requests enable the same group while a sync or disable
request runs. Both callers can observe no anchor. If the implementation follows
the existing create-with-inbox shape, the identity pre-check occurs outside the
write transaction (`packages/business/src/contact/create-with-inbox.ts:136-150`)
and the transaction inserts a new Contact, ContactInbox, and Conversation
(`create-with-inbox.ts:180-224`). One transaction can lose the ContactInbox
unique race and abort, or a disable can overwrite the group policy while the
other transaction is still provisioning. Without a locked/CAS group-row update,
the group can point at no complete anchor, or an anchor can be committed after
the policy has been turned off. If a caller accidentally varies the reserved
source key, the existing indexes also do not prevent two anchors.

**Evidence:** The group table currently has only the account/provider-group
unique key (`integration-zalo-account.ts:81-87`); the planned nullable anchor
references are not themselves an idempotency key. ContactInbox uniqueness is
only `(inboxId, sourceId)` (`contact-inbox.ts:186-190`) and Conversation
uniqueness is only per contact/source (`conversation.ts:83-88`). The current
group policy update is a plain scoped update with no version or row lock
(`packages/database/src/repositories/integration-zalo-account/group-repository.ts:119-139`).

**Required fix:** Define one stable reserved source key and serialize all
enable/disable/sync transitions with a row lock or compare-and-set policy
version. In one transaction, lock the group, re-read policy, create/find all
three anchor rows, verify their `kind`/source invariants, set both references,
then commit. On a uniqueness conflict, re-read the committed winner and return
it; never leave a partially populated group row. Disable must only change policy
and retain history. Add concurrent enable-vs-disable and retry-after-unique-
conflict cases to the acceptance tests.

## 3. High — stable queue IDs do not provide durable WebSocket dedupe or replay-safe realtime

**Location:** `phase-10-full-group-inbox.md:22-27,44-49,58-60`,
`plan.md:84-90`; current event and message paths at
`apps/zalo-account-gateway/src/runtime/provider-message.ts:27-30,148-159`,
`apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts:181-195,326-340`,
`apps/worker/src/events/zalo-account/handler.ts:88-112,165-182`,
`packages/worker-config/src/lib/connection.ts:103-115`, and
`packages/database/src/sharding/message/repository/sharded-message-repository.ts:1529-1586`.

**Scenario:** A reconnect overlap or EventBus reclaim delivers the same provider
message after the first worker has committed the Message but before/after its
realtime side effect. BullMQ removes completed jobs after 1,000 rows, so the
same stable job ID no longer deduplicates a later redelivery. A group handler
that derives a different `createdAt`, omits the stable source ID, or emits
realtime outside the `isNew` critical section can create a second message or a
second `message:received`/realtime event. Delayed events can likewise commit
older state after newer state unless group message ordering is explicit.

**Evidence:** The current group normalizer discards all content and returns
only `{threadId, providerMessageId}` (`provider-message.ts:27-30,148-159`), and
the publisher assigns a fresh random event ID to every envelope
(`fenced-event-publisher.ts:181-188,326-334`). The current handler's stable ID
only exists at enqueue time (`handler.ts:100-112`), while the queue removes old
completed jobs (`connection.ts:103-115`). Existing Message dedupe depends on a
source ID and a time-aware lookup (`sharded-message-repository.ts:1529-1586`);
the source uniqueness also includes `createdAt` (`packages/database/src/schema/message.ts:87-93`).

**Required fix:** Make `(accountId, providerGroupId, providerMessageId)` a
durable identity, mapped to one immutable Message source ID (or a dedicated
inbox ledger with a database unique constraint). Atomically decide `isNew` before
any notification/realtime/automation/outbox effect; duplicates must be no-ops.
Persist an advance-only provider timestamp/order watermark for lifecycle events
that can arrive out of order. Test a worker crash/reclaim after DB commit, a
redelivery after BullMQ removal, and self echo before the command result.

## 4. High — `unknown` send outcomes have no durable reconciliation state

**Location:** `phase-13-advanced-message-lifecycle.md:23-24`,
`phase-14-public-api-cli-mcp.md:26-33,54-64`; current paths at
`apps/zalo-account-gateway/src/transport/command-executor.ts:150-182`,
`packages/business/src/zalo-account/transport.service.ts:449-480`,
`packages/business/src/zalo-account/group.service.ts:99-127`, and
`apps/zalo-account-gateway/src/transport/command-executor.ts:103-106`.

**Scenario:** A runtime disconnect before provider admission, a provider
timeout after acceptance, and a response lost after a split media send are all
reported to callers as “unknown.” The planned canonical chat worker can then
leave a user-visible send failed or allow a later manual send, while a delayed
self echo proves that the provider accepted the original. The command state and
result are only retained for the executor's default 24-hour TTL; there is no
canonical outbound Message state or command-to-echo reconciliation in the
current group service, which returns provider IDs directly.

**Evidence:** The executor classifies every exception from `send_direct`,
`send_group`, and `update_labels` as `unknown` (`command-executor.ts:160-180`),
including errors that may occur before the provider call. `waitForResult()` then
throws “do not retry automatically” for both an explicit unknown result and a
wait timeout (`transport.service.ts:449-480`). `send()` checks policy once and
immediately waits for IDs (`group.service.ts:106-127`); it does not persist a
pending/unknown outbound record. The executor's default state TTL is 24 hours
(`command-executor.ts:101-106`).

**Required fix:** Separate pre-dispatch validation/admission failures (`failed`)
from post-admission transport ambiguity (`unknown`). Persist a canonical
outbound Message/attempt with `pending`/`unknown`, command ID, client message ID,
and group scope before dispatch. Correlate later self echo/provider IDs to that
attempt and reconcile it idempotently; block automatic replay while exposing an
explicit resolution path. Keep the durable reconciliation record longer than
the short Redis command-result TTL. Test provider-accepted-then-timeout and
disconnect-before-provider-call separately.

## 5. High — rollback flags do not fence already-queued group work

**Location:** `plan.md:109-111`, `phase-11-group-controls.md:18-26,51-56`,
`phase-10-full-group-inbox.md:26-27,60`; current paths at
`apps/worker/src/events/zalo-account/handler.ts:83-195`,
`packages/business/src/zalo-account/group.service.ts:106-127`,
`apps/zalo-account-gateway/src/transport/command-executor.ts:109-147`, and
`apps/zalo-account-gateway/src/transport/provider-admission.ts:38-44`.

**Scenario:** An event is accepted and a group message/send job is queued just
before the kill switch is turned off. The rollback then updates flags, but a
worker holding a stale policy read can still persist or send it; delayed jobs
and retries remain in BullMQ. The gateway command executor checks lease owner /
target fencing and provider circuit admission, not the account/group policy.
“Stop accepting new group events” therefore does not stop work already accepted.

**Evidence:** The current event handler enqueues account events without a group
policy/epoch gate (`handler.ts:83-195`). The group service reads
`accessible && sendEnabled` once before `sendGroupAndWait`
(`group.service.ts:106-127`). Executor admission only returns a delay from an
in-memory provider failure window (`provider-admission.ts:38-44`), while the
executor's target checks are owner/fence checks (`command-executor.ts:109-147`).

**Required fix:** Add an account/group policy epoch or fencing token to every
group event/job/command. Re-evaluate it in the worker and atomically at provider
admission immediately before persistence/send; an off/changed epoch must be a
non-retryable no-op. Rollback must park/cancel delayed group jobs, drain in-flight
group work, and then roll workers/gateway, while leaving direct traffic and
historical anchors/messages intact.
