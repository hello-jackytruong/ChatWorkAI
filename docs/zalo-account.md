# Zalo Account channel

`zaloAccount` connects a personal Zalo account to ChatbotX. It is separate from
the existing `zalo` channel, which uses the official Zalo OA API.

> Personal-account connectivity relies on the unofficial `zca-js` protocol.
> Provider behavior and account restrictions can change without notice.
> Operators must review Zalo's applicable terms and accept account-suspension
> risk before enabling this channel.

## Architecture and safety boundary

- Only `apps/zalo-account-gateway` imports `zca-js` and owns personal-account
  WebSockets. Builder, worker, business, and integration code use typed SDK
  commands/events only.
- `Connection` is the durable lifecycle source of truth.
  `IntegrationZaloAccount` stores verified profile data and encrypted device
  authorization. Public projections never return cookies, IMEI, user-agent, or
  encrypted auth.
- Commands carry workspace, account, Inbox, command ID, expiry, and—after a
  runtime exists—the exact owner/fence target. Gateway replicas serialize work
  per account and verify the Redis lease before an SDK call.
- Event publication atomically checks the current lease/fence. Stale callbacks
  cannot append accepted events.
- Command and event streams use consumer groups, bounded reclaim, stable IDs,
  poison DLQs, processing timeouts, and hard stream capacity. Entries are
  deleted only after ACK, so capacity control cannot silently trim pending
  work.
- QR and authorization event bodies are encrypted with session/fence-bound AAD.
  Poison logging and command DLQ records contain metadata only, not payloads.
- A send or whole-label write that may have reached the provider has an
  `unknown` outcome and is never replayed automatically. Known rejection before
  the provider call is a failure; it does not trip the provider circuit.
- Account and provider-wide admission circuits temporarily pause work after a
  burst of failures. Readiness requires Redis, a live consumer heartbeat, and
  acceptable command-stream lag.

## Setup

The gateway is disabled by default. Configure the shared `REDIS_URL`, then set:

```dotenv
ZALO_ACCOUNT_GATEWAY_ENABLED=true
ZALO_ACCOUNT_GATEWAY_HOST=0.0.0.0
ZALO_ACCOUNT_GATEWAY_PORT=3211
ZALO_ACCOUNT_LEASE_TTL_MS=30000
ZALO_ACCOUNT_LEASE_RENEW_MS=10000
ZALO_ACCOUNT_GATEWAY_OWNER_ID=zalo-gateway-01
```

`ZALO_ACCOUNT_GATEWAY_OWNER_ID` is required when enabled and must be stable and
unique for each concurrently running replica. The renewal interval must stay
below half the lease TTL. Start the app with its workspace command:

```bash
pnpm --filter zalo-account-gateway start
```

Use `GET /healthz` for process liveness and `GET /readyz` for traffic
readiness. Shutdown first rejects readiness, stops command consumption, stops
and releases runtimes, drains Redis, and has a 30-second hard deadline.

Channel visibility remains controlled by the tenant channel policy. Hiding the
channel blocks new creation but does not make an already-connected account
unmanageable.

## Connect, reconnect, and disconnect

The provider uses the shared `qr_device` connection strategy and existing
`ConnectSession` state machine:

1. Create a connection session with provider `zaloAccount` through the existing
   connections public API or the channel UI.
2. Poll the existing connect-session endpoint. The short-lived `show_qr` action
   contains the QR image and is cleared on scan, expiry, cancel, or completion.
3. The trusted worker claims the encrypted authorization once, verifies the
   account UID, stops the temporary `connect_session` runtime, and persists one
   Inbox/account binding.
4. A post-commit activation command starts the durable account runtime. If that
   activation fails, the committed connection is marked `degraded`; it is not
   falsely reported as rolled back.

Closing the QR dialog cancels the pending runtime. Reconnect preserves the
existing Inbox/account row and requires the same verified UID. Disconnect,
workspace pause/delete, and purge must receive a confirmed fenced stop before
they mutate or remove authorization data; a timeout fails closed.

Public lifecycle operations use the existing agent-first connection surfaces:
`connections.create`, `connectSessions.get`, `connections.reconnect`, and
`connections.disconnect`. Safe Zalo account metadata is available at:

- `GET /v1/zalo-accounts`
- `GET /v1/zalo-accounts/{id}`

All operations require the normal `channels` workspace-token scope.

## Direct messages

Supported 1:1 inbound/outbound content is deliberately small:

- text;
- reply/quote metadata;
- image;
- file.

Inbox sends support text together with one image; both are passed to the
provider in the same send command. The provider can send the text separately
when quote metadata is present. Text with a file and multiple attachments per
command remain unsupported. The dedicated direct/group send API endpoints
continue to accept either text or one attachment.

Inbound messages, own echoes, delivery/read status, and undo events enter the
existing integration worker and canonical Inbox persistence/realtime pipeline.
Provider/account/thread/message identity is included in dedupe IDs so a retry
does not create a second Inbox message.

Outbound media is fetched only through the controlled download path: HTTPS,
allowlisted resolution checks, redirect revalidation, byte/type limits, and a
temporary local file that is removed after the SDK call. Arbitrary local paths
and provider URLs are not exposed as client-facing attachments. Sticker,
voice/video, card, poll, outbound reaction, forward, and other unsupported payloads fail
explicitly; they are not silently converted.

## Controlled group Inbox

`IntegrationZaloAccountGroup` owns provider metadata and policy. Enabling receive
**or send** creates one internal `Contact(kind=channelGroup)`, `ContactInbox`
and Conversation under the reserved `za:group:` source namespace. Disabling
retains history. A send-only group has an outbound timeline but does not persist
incoming messages. Members remain sender metadata; they do not become Contacts.

The internal anchor is excluded from customer CRUD/export, contact quota/MAC,
broadcasts, sequences, pipelines and customer scoring. Group persistence uses
its own facade and durable provider identity, with bounded recovery across
database/shard/queue failures. The Inbox renders actual sender, validated mention
spans, quotes and supported text/image/file attachments. Own echoes reconcile
confirmed provider IDs. Group metadata events still schedule coalesced refreshes.

The account kill switch and every group's receive/send flags default off;
automation defaults `disabled`. Turn on the account switch and select individual
groups. Automation can be `mentionOnly` or `all`, with a closed allowlist of
reply sends and tag changes. Only the supported send/tag/Wait flow subset can
execute for a group. Original policy epochs travel through retries and delayed
work; disabling then re-enabling cannot authorize old queued jobs. Provider
admission checks current policy and account/group limits immediately before send.
Direct traffic continues when the group switch is off.

Sync does not tombstone missing groups unless the provider snapshot is proven
complete. Partial, stale and failed scans retain existing metadata/policies.

Public operations:

- `GET /v1/zalo-accounts/{accountId}/groups`
- `GET /v1/zalo-accounts/{accountId}/groups/{id}`
- `POST /v1/zalo-accounts/{accountId}/groups/sync`
- `PATCH /v1/zalo-accounts/{accountId}/groups/{id}/policy`
- `POST /v1/zalo-accounts/{accountId}/groups/{id}/messages`
- `PATCH /connections/zalo-account/{accountId}/group-messaging`
- `PATCH /connections/zalo-account/{accountId}/groups/{groupId}/policy`

The send endpoint accepts exactly one of text or one supported attachment and
requires a caller-provided stable `commandId`.

## Canonical sends and message lifecycle

Direct sends (`POST /v1/zalo-accounts/{accountId}/messages`) select a known
ContactInbox or existing provider UID, never an arbitrary phone number. Direct
and group API sends prepare a fixed Message identity before enqueueing the
existing chat worker. Reuse a command ID only with identical input. Inspect
`GET /v1/zalo-accounts/{accountId}/send-attempts/{commandId}` with the same
target after a timeout; the read remains available when sending is disabled.
`applied` returns confirmed provider IDs. `pending`/`unknown` must not be
automatically resent, and manual resend is blocked for pending/unknown/applied
attempts. Prepared work that has not reached provider dispatch has bounded
recovery; dispatched work is never automatically replayed.

Delivered/seen receipts, typing, reaction add/remove and inbound undo enter the
typed lifecycle path. Group receipts never mark customer activity. Group undo
records a durable tombstone before resolving a missing Message, preventing late
messages or reactions from restoring it. Direct missing targets use bounded
lookup retries. Receipt/reaction detail is retained for 90 days and purged in
bounded batches; durable dedupe identities remain compacted.

`GET /v1/zalo-accounts/{accountId}/message-state` reads at most 50 provider
message IDs per request (reaction aggregates are bounded to 2,500 rows).
`POST /v1/zalo-accounts/{accountId}/typing` is ephemeral, throttled to one call
per thread per five seconds; the Inbox expires the indicator locally. Outbound
reaction/revoke/delete remain unavailable until live provider proof. Local
delete is rejected before mutation so it cannot appear to unsend a Zalo message.

## Friend sync and safe status

`POST /v1/zalo-accounts/{accountId}/friends/sync` imports up to 500 provider
entries per page, in sequential transactions of 100. Follow `nextCursor` with
a new command ID until complete. UID is account-scoped; updates fill missing
profile fields and missing friends are never deleted. Each newly created person,
ContactInbox, import ledger and durable contact counters commit together. A
revision-fenced cache outbox recovers invalidation after crashes without counting
twice. Imports emit no customer-created/activity automation and consume no MAC.

`GET /v1/zalo-accounts/{accountId}/status` exposes Connection state, gateway
availability, capabilities and friend/group/label sync summaries. Availability
means a current lease exists, not a provider health guarantee. It never returns
authorization, operation tokens or gateway fencing identifiers.

## Native labels and ChatbotX tags

Zalo labels are an account-wide versioned document. Sync maps provider label
definitions through `TagChannel(channelType=zaloAccount,
integrationId=accountId)` and applies assignments to existing direct threads
and explicitly provisioned group anchors in the owning Inbox. It never creates
member Contacts. Group tagging uses a quiet service and does not emit customer
activity, lead events or MAC.

Attach/detach performs a serialized read-modify-write of the whole provider
document, preserves unrelated labels/conversations, and retries once only for
a verified version conflict. Empty/stale snapshots are non-destructive. A
provider label rename updates the mapped ChatbotX Tag when it does not collide
with another Tag name.

Creating a new local Tag does not invent a provider-native label ID. Only
labels discovered from Zalo can be mapped and attached back to Zalo. The
generic ChatbotX tag attach/detach operations drive mapped provider updates.

Manual sync is available at:

- `POST /v1/zalo-accounts/{accountId}/labels/sync`
- `GET /v1/zalo-accounts/{accountId}/groups/{groupId}/tags`
- `PATCH /v1/zalo-accounts/{accountId}/groups/{groupId}/tags`

Whole-document writes are fenced by an operation token/version/hash. Unknown
writes remain inspect-only until reconciliation; unconfirmed detach mappings
are retained. Missing or incomplete snapshots do not erase assignments. The
settings UI reports conflict/unknown/partial states rather than implying success.

## Database rollout

The migration chain includes these generated changes; the implementation
workflow does not apply migrations:

- `packages/database/drizzle/20261119161633_zalo-account/`
- `packages/database/drizzle/20261120060156_zalo-account-groups/`
- `packages/database/drizzle/20261121024313_zalo-account-group-inbox/`
- `packages/database/drizzle/20261121055141_zalo-account-message-operations/`

Inspect and apply them in order only after explicit approval. Until then,
database-backed Zalo integration tests and live channel operation remain a
rollout gate; unit/contract/type checks do not replace this approval.

The group Inbox migration adds the immutable person/group discriminator,
anchor references, policy defaults/epochs, durable identity and kind-aware
contact-stat triggers. The operations migration adds receipt/reaction/attempt
enums and tables, friend import/cache ledger, operations summaries, Wait audience,
identity tombstones/recovery index and the reserved-source constraint. FKs have
leading indexes and purge drains the new children before account/workspace rows.

Apply the additive migrations **before deploying this code**: normal Contact
and account selects now read the new columns. Then deploy builder, workers and
gateway together with group flags off. Enable only a bounded staging account
after redacted live fixtures verify the pinned provider contract; static tests
do not authorize production enablement.

## Operations and rollback

Watch gateway readiness, consumer lag, command/result timeouts, DLQ growth,
admission pauses, lease loss, reconnect churn, and provider rate-limit errors.
Validate real message/group/label payloads against pinned `zca-js` 2.1.2 in a
bounded staging account before enabling a production cohort.

To roll back group behavior, disable the account group switch first. Its epoch
fences queued group work while direct messaging continues. Disable per-group
receive/send/automation and drain in-flight group work. Preserve anchors,
history and reconciliation records. A whole-channel rollback additionally stops
accepting new work and drains/stops gateway runtimes; schema or secret deletion
requires a separate retention decision.
