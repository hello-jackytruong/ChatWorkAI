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
- A failed provider send or whole-label write is an `unknown` outcome and is
  never replayed automatically. Read/reconnect failures are explicit failures.
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

Inbound messages, own echoes, delivery/read status, and undo events enter the
existing integration worker and canonical Inbox persistence/realtime pipeline.
Provider/account/thread/message identity is included in dedupe IDs so a retry
does not create a second Inbox message.

Outbound media is fetched only through the controlled download path: HTTPS,
allowlisted resolution checks, redirect revalidation, byte/type limits, and a
temporary local file that is removed after the SDK call. Arbitrary local paths
and provider URLs are not exposed as client-facing attachments. Sticker,
voice/video, card, poll, reaction, forward, and other unsupported payloads fail
explicitly; they are not silently converted.

## Controlled group sending

Groups are provider-scoped resources, not Contacts or Inbox conversations.
Sync stores group metadata under its owning workspace/account. New groups have
`sendEnabled = false`; inaccessible/removed groups also cannot send.

Group activity schedules a coalesced group-resource refresh only. It never
enters direct-message/audience handlers, creates a Contact, or runs 1:1 flow
automation. Sending requires the exact stored group row and explicit policy
enablement.

Public operations:

- `GET /v1/zalo-accounts/{accountId}/groups`
- `GET /v1/zalo-accounts/{accountId}/groups/{id}`
- `POST /v1/zalo-accounts/{accountId}/groups/sync`
- `PATCH /v1/zalo-accounts/{accountId}/groups/{id}/policy`
- `POST /v1/zalo-accounts/{accountId}/groups/{id}/messages`

The send endpoint accepts exactly one of text or one supported attachment and
requires a caller-provided stable `commandId`.

## Native labels and ChatbotX tags

Zalo labels are an account-wide versioned document. Sync maps provider label
definitions through `TagChannel(channelType=zaloAccount,
integrationId=accountId)` and applies assignments only to existing direct
`ContactInbox` rows in the owning account Inbox. Group IDs are excluded before
contact resolution.

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

## Database rollout

Two generated migrations are required and intentionally are not applied by
the implementation workflow:

- `packages/database/drizzle/20261119161633_zalo-account/`
- `packages/database/drizzle/20261120060156_zalo-account-groups/`

Inspect and apply them in order only after explicit approval. Until then,
database-backed Zalo integration tests and live channel operation remain a
rollout gate; unit/contract/type checks do not replace this approval.

## Operations and rollback

Watch gateway readiness, consumer lag, command/result timeouts, DLQ growth,
admission pauses, lease loss, reconnect churn, and provider rate-limit errors.
Validate real message/group/label payloads against pinned `zca-js` 2.1.2 in a
bounded staging account before enabling a production cohort.

To roll back, hide/disable the Zalo Account channel, stop accepting new work,
let accepted stream entries drain, and stop gateway runtimes. Keep encrypted
account/group rows for controlled recovery; schema or secret deletion requires
a separate retention decision.
