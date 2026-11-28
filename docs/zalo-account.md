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

The gateway is enabled by default and uses the shared Redis connection.
History and reconnect catch-up, label reconciliation, message integrity, media
archival, rich sending, contact management and native message operations are
also available by default. Existing explicit rollout overrides still apply.
Bind address, port and lease settings can be overridden.

```dotenv
ZALO_ACCOUNT_GATEWAY_HOST=0.0.0.0
ZALO_ACCOUNT_GATEWAY_PORT=3211
ZALO_ACCOUNT_LEASE_TTL_MS=30000
ZALO_ACCOUNT_LEASE_RENEW_MS=10000
```

The gateway creates a unique owner ID for each running process. Set
`ZALO_ACCOUNT_GATEWAY_OWNER_ID` only when the deployment supplies a stable
replica ID, with a distinct value per concurrent replica. The renewal interval
must stay below half the lease TTL. Start the app with its workspace command:

```bash
pnpm --filter zalo-account-gateway start
```

Use `GET /healthz` for process liveness and `GET /readyz` for traffic
readiness. Readiness requires the dedicated blocking Redis connection to be
ready; the command consumer explicitly connects it before reading the stream,
including when offline queuing is disabled. Shutdown first rejects readiness, stops command consumption, stops
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

QR scan means waiting for phone confirmation; it is not a completed connection.
Decline, expiry and cancellation are terminal, clear the QR image, and cannot be
overwritten by a late login callback. Only a completed `ConnectSession` closes
the dialog as successful. SDK request cancellation and physical socket close
must settle before a replacement can attach: calling `listener.stop()` alone
does not prove closure. A close timeout retains the local ownership tombstone
and fails the operation rather than claiming a successful stop.

The channel settings list shows each account's name and connection status.
Open **Configure** for reconnect/disconnect, read-receipt settings, group policies,
and sync details. Status distinguishes durable **Connection**, current gateway
**lease**, and a **verified socket sample**. A connected Connection and a lease
alone do not mean the Zalo socket is open. A failed status read is shown as
unavailable.
A confirmed disconnect updates the cached status immediately. Completing QR
setup closes the QR dialog, shows a success notification, and refreshes account
and Inbox data; failed or expired sessions offer a retry.

Visible settings use status-only polling every 30 seconds; hidden tabs and
unmounted settings pause it. Rows do not poll group lists. IDs-only workspace
realtime hints coalesce over 250 ms using the existing workspace socket and
invalidate status queries; they neither grant permission nor complete a QR
session. See [status query owner](../apps/builder/src/features/zalo-accounts/queries/use-account-status.ts).

Public lifecycle operations use the existing agent-first connection surfaces:
`connections.create`, `connectSessions.get`, `connections.reconnect`, and
`connections.disconnect`. Safe Zalo account metadata is available at:

- `GET /v1/zalo-accounts`
- `GET /v1/zalo-accounts/{id}`

All operations require the normal `channels` workspace-token scope.

## Rich content in the Inbox

Personal Zalo chats display video, voice, GIF, link previews, contact cards,
locations, bank/QR information and call notices when the incoming payload
includes the required fields. Photo descriptions from the socket are retained
as message text. For eligible received photos, the Inbox displays a short-lived
provider preview while the existing worker archives the original. Reopening a
conversation prefers the private R2/S3 object when it is ready. The original
photo URL remains encrypted in the asset record.

Sticker artwork uses the public Zalo CDN and begins with the numeric sticker
ID when catalog metadata is unavailable. GIFs use a validated HTTPS Zalo
source. Neither creates new R2/S3 archive objects. Previously stored content
stays available subject to existing access and retention rules. Videos, photos,
files and eligible audio continue through normal archival.

Typed outbound messages are available by default. Deployments can restrict access with `ZALO_ACCOUNT_RICH_SEND_ACCOUNT_IDS` set to a comma-separated list of internal account IDs in Builder, Worker and Gateway, or pause it with `false`. Existing text and single-attachment inputs remain available. For the public DM and group send commands, pass one typed `content` object or a `forward` source pointer with the source conversation ID, message ID and creation timestamp. For media forwarding the source attachment must already be available in the archive.

The API exposes `delivery=partial` when only part of a multi-item send is confirmed. `remainingUnknown` indicates a later attempt may have reached the provider. `delivery=accepted_without_id` records an acknowledgment without a provider message ID. Inspect the existing send attempt for either outcome before issuing another command.

Search sticker packs through `zaloAccounts.listStickers`, then use the returned ID, category and type to send a sticker. The gateway looks up catalog entries under the account session. The picker groups stickers by the provider category ID and uses the static, WebP, or sprite artwork returned by the catalog. No new sticker artwork is copied to private storage. The picker keeps recent and favorite entries per user and account in the current browser.

`zaloAccounts.searchHistory` reads one bounded Inbox history page in the specified account and conversation. Follow the cursor for older pages, including pages with zero matches. `zaloAccounts.locateQuote` reads a bounded page near the quoted timestamp and returns the visible original if found. Group mentions use provider UIDs from `zaloAccounts.listGroupMembers` and the gateway rechecks current membership before sending. All three read operations require `inbox` scope and conversation access. Member names may be missing when the provider returns a partial roster.

## Direct messages

The legacy 1:1 message shape supports:

- text;
- reply/quote metadata;
- image;
- file.

The legacy Inbox input supports text with one image. The provider can send
the caption separately when quote metadata is present. Enrolled accounts use
the typed media input for multiple files or text with a file. The dedicated
direct/group API also accepts each legacy input.

Inbound messages, own echoes, delivery/read status, and undo events enter the
existing integration worker and canonical Inbox persistence/realtime pipeline.
Provider/account/thread/message identity is included in dedupe IDs so a retry
does not create a second Inbox message.

The controlled outbound download path checks HTTPS sources, DNS resolution,
redirects, byte limits and media types. It removes temporary local files
after the SDK call. Inbox attachments are projected through the storage
policy. The send API rejects unsupported content such as polls.

## Group Inbox

Verified groups can send and receive by default. The first supported incoming
message or explicit send creates one internal `Contact(kind=channelGroup)`,
`ContactInbox` and Conversation under the reserved `za:group:` namespace.
The existing queue refreshes the group list after a verified socket opens or
the connected account joins a group. Subsequent group activity shares the same
bounded refresh path. A group sync
marks an unseen group inaccessible only when the snapshot is complete.
Members remain sender metadata.

The internal anchor is excluded from customer CRUD/export, contact quota/MAC,
broadcasts, sequences, pipelines and customer scoring. Group persistence uses
its own facade and durable provider identity, with bounded recovery across
database, shard and queue failures. The Inbox renders the actual sender,
validated mentions, quotes and supported text/image/file attachments.

The account settings expose group automation with three modes. New groups use
`disabled`. Choose `mentionOnly` to act on mentions of the connected account
or `all` for every eligible message. Existing configured automation is
preserved. Only the supported reply, tag and Wait flow subset can execute for
a group. Operational endpoints can still suspend Inbox group traffic. Policy
epochs fence earlier queued work, and provider admission checks the current
membership, permissions and rate limits before sending.

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

### Group administration reads

In account settings, group details open on demand. The panel separates the
connected account's Zalo role and provider restrictions from its ChatbotX Inbox
policy. The roster returns at most 50 entries per page and enriches that page in
one provider batch. A cursor belongs to one workspace, account, group and roster
version. A partial result can have no continuation cursor when Zalo hides or
omits members. The shared-groups view is explicit and requires provider support
for the current account and a verified friend in the selected roster.

Use `GET /v1/zalo-accounts/{accountId}/groups/{groupId}/administration`,
`/administration/members` and `/administration/related-groups` with the `channels`
scope. The CLI commands are `zalo-accounts:groups:overview`,
`zalo-accounts:groups:roster` and `zalo-accounts:groups:related`. The Inbox
mention operation retains its conversation and send policy checks.

### Native group management

The management panel opens provider lists on demand and uses current Zalo role
evidence before a write. Set `ZALO_ACCOUNT_GROUP_MANAGEMENT_ACCOUNT_IDS` only
to restrict supported writes to an account list or pause them with `false`. Keep the
same time-prefixed UUID v4 (`<unix-ms>:<uuid>`) when inspecting a command after
an interrupted request. The attempt records only scoped actor/operation and
sanitized outcome evidence. A provider approval request can be pending after
the CRM attempt has completed. Link inspections send the invitation in the body.

Zalo generates a link when creating a group. Use the current link state in group
settings to check it. Whole-document settings writes and upgrades to community
remain unavailable pending verification with an isolated Zalo account.

The `channels` API is under `/v1/zalo-accounts/{accountId}/group-management`.
Read with `GET`, submit a write with `POST`, inspect a link with
`POST /inspect-link`, and inspect a retained result with `GET
/attempts/{commandId}`. `GET /capability` reports whether native writes are enabled.

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
messages or reactions from restoring it. Direct missing targets also retain durable recall intent; bounded repair resolves an existing anchor before creating a stable placeholder. Receipt/reaction detail is retained for 90 days and purged in
bounded batches; durable dedupe identities remain compacted.

`zaloAccounts.getMessageState` reads at most 50 provider message IDs per
request. Inbox shows confirmed delivery state in direct chats and separate
delivery and seen counts in groups. The detail popup uses
`zaloAccounts.getMessageStateDetails` and reads up to 50 receipt actors and
50 reaction entries for one visible, authorized message. The displayed time
can be the time the gateway observed an event.

`zaloAccounts.sendTyping` is ephemeral and throttled to one call per thread
per five seconds. Direct and group indicators expire locally.
Enable `ZALO_ACCOUNT_REACTIONS_ENABLED` to allow add, change, and remove
operations through `zaloAccounts.setReaction`. The Inbox waits for event
evidence before changing counts. `ZALO_ACCOUNT_REACTION_HISTORY_ENABLED`
allows one reaction history request per account and stream type every 24
hours. The response is asynchronous.

`zaloAccounts.sendSeen` and `zaloAccounts.sendDelivered` require the account
ID in `ZALO_ACCOUNT_OUTBOUND_RECEIPT_ACCOUNT_IDS` in the Builder and gateway,
and an authorized incoming message with the exact original provider fields.
For groups, the current group send policy also applies. Marking a CRM
conversation read is a local operation. Reaction sends, reaction history
requests and outbound receipts are disabled by default.

Native recall and provider deletion are available by default. Local hide retains originals. Generic channel deletion continues to use the existing Zalo-specific rules.

### Message integrity and bounded recovery

The normalized message reader accepts legacy payloads and optional
`schemaVersion: 1` evidence. Deploy compatible SDK, worker and Inbox readers
before deploying the gateway, which emits integrity evidence by default. Set
`ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED=false` to pause the new producer fields. A message
with valid identity but unsupported content is retained as a localized
placeholder, without synthetic customer text, attachments or automation. Invalid
identity is diagnosed without retaining the raw provider body. Minute diagnostics
use fixed reason codes and bounded callback backlog counts/bytes.

Confirmed ACKs retain up to ten provider IDs, with a stable primary ID. An exact
alias may reconcile own-echo rows to the canonical Message; matching text, time
or client command ID alone does not prove ownership. Native-phone echoes remain
visible. Merges preserve attachments and reply references; unsafe shard or
translation cases retain data and become `needs_review`. Provider send status
and local reconciliation status are separate.

Inspect an Inbox/flow send with
`GET /v1/zalo-accounts/{accountId}/messages/{messageId}/send-attempt`, passing
`messageCreatedAt` from `messages.list`. This complements the command-ID route;
both return the same bounded outcome projection and remain readable when sending
is disabled. The Inbox inspect action requires workspace `superAdmin`; the
public read requires the existing `channels` token scope. Inspect is on demand,
with no per-message polling. Pending, unknown and accepted sends are not
resendable. Errors expose safe enum codes, phase, action and optional
`retryAfterMs`; arbitrary provider errors are not displayed.

Local repair reuses the existing recovery scheduler: at most 20 rows, a five-second admission budget per tick and at
most three repair attempts. New ACK/claim/merge transactions bound lock waits to
500 ms and individual SQL statements to one second; existing account/shard
registry reads mean the tick is not a hard five-second wall-clock deadline. It never invokes a provider
send. Legacy attempts without reconciliation JSON do not become a new backlog.
The nullable reconciliation column and partial index require the reviewed core
migration before deploying these readers/writers. Do not apply it automatically.

Operational send defaults are 60 direct sends per account/minute; groups retain
60/account/minute and 10/group/minute. These are application limits, not published
Zalo quotas. Capacity is checked immediately before dispatch after preparation;
groups are not charged twice. Admission fails closed when Redis is unavailable.
Only pure reads (`sync_groups`, `sync_friends`, `get_labels`) may retry once,
within the original deadline and after rechecking ownership/admission. Writes
with uncertain dispatch remain unknown and are never replayed automatically.

Rollback: disable the integrity message producer gate and drain new-format events
before downgrading strict readers. Structured command-result errors also need
compatible readers; retain them until new-format retained results are drained
or expired. The message gate only controls normalized message fields. Retain reconciliation and message evidence. Stop
repair before rolling back its consumer; preserve the additive column/index
until a separately approved data-retention decision. Automated evidence and
remaining database/live-provider gates are tracked in the
[implementation report](../plans/261123-0500-zalo-account-message-integrity-recovery-tdd/reports/implementation.md).

## Provider history and reconnect catch-up

History sync is available by default. An account-wide run imports available direct
messages for existing Inbox conversations. A conversation run can import direct
messages or a permitted group's history window. History uses the provider's
original timestamps, preserves recalls, and emits no new-message notifications,
automation, customer activity, or MAC. Media uses the existing background archive.

Start or resume imports one bounded page. `canResume` indicates whether another
attempt can use the retained checkpoint. `complete` means this run reached the
end of the data Zalo returned for its scope. The pinned group API accepts no
cursor and can return only one window. The reported message count covers
accepted message identities in persisted pages, including messages already
stored from realtime delivery. `skipped` covers entries outside the eligible
Inbox scope or entries that cannot be imported. The cursor can advance past
these entries with a partial result. Storage failures or uncertain writes keep
the current checkpoint for retry.

The latest run is retained on the account and is readable only in its exact
account or conversation scope. Starting another run can replace the retained
checkpoint. The existing low-priority worker imports one direct-history page
after a verified socket opens.
Reconnects within five minutes coalesce. An automatic run preserves an existing
resumable manual checkpoint. Use `ZALO_ACCOUNT_HISTORY_AUTO_SYNC_ENABLED=false`
to pause catch-up or `ZALO_ACCOUNT_HISTORY_SYNC_ENABLED=false` to pause provider
history requests while retaining progress.

For account history, use `GET` or `POST /v1/zalo-accounts/{accountId}/history-sync`
and `POST /v1/zalo-accounts/{accountId}/history-sync/{runId}/resume` with the
`channels` scope. For conversation history, use the same suffixes under
`/v1/zalo-accounts/{accountId}/conversations/{conversationId}` with the `inbox`
scope and the matching `contactInboxId`. Use a stable `commandId` for start and
each resume. In the CLI these are `zalo-accounts:history-sync:status`,
`:start`, and `:resume`, and the corresponding commands use
`zalo-accounts:conversation-history-sync` for a single conversation.

## Native conversation settings

Open **Settings on Zalo** on a selected Zalo Account conversation to read its
provider pin, mute, archive, unread, auto-delete and hidden state. The panel
distinguishes unknown values if Zalo sends incomplete data. Native settings
leave ChatbotX unread counters, archive state and retention independent. Mute
uses seconds. Auto-delete uses milliseconds and accepts 0, 1, 7 or 14 days.

Use `GET` or `PATCH /v1/zalo-accounts/{accountId}/conversations/{conversationId}/native-settings`
with the `inbox` scope and selected `contactInboxId`. Read a command result with
`GET /attempts/{commandId}` under the same path.
`ZALO_ACCOUNT_CONVERSATION_SETTINGS_ACCOUNT_IDS` can restrict supported writes
to specified accounts or pause them with `false`.
Hidden-conversation PINs are removed at the gateway, and PIN update/reset stay
unavailable pending controlled provider verification.

## Account profile and avatar management

The account configuration opens the native profile on demand. Profile QR,
business package and avatar history are separate reads. Profile operations derive
the account's own UID from the active provider session. Editing an existing
profile preserves the complete current provider identity and business category.
Avatar reuse or deletion checks the selected photo against its current account
album page. Confirmed new account avatars are eligible for background archival.

Use `GET` and `PATCH /v1/zalo-accounts/{accountId}/native-profile` with the
`channels` scope. Use `GET /attempts/{commandId}` under the same path to inspect
an edit. Use `ZALO_ACCOUNT_PROFILE_OPERATIONS_ACCOUNT_IDS` only to restrict
supported writes. The provider's language and
activity calls remain unavailable pending verified device-side effects. A
per-account proxy requires a separate deployment decision and transport proof.

## Native quick messages and auto-replies

Native tool results between the gateway and Builder are encrypted for the exact
workspace, account, Inbox, command and operation.

The account configuration loads one reply tab at a time. Quick messages support
text and a single attached image. An edit keeps existing media until the operator
explicitly removes or replaces it. When media storage is enabled, the archive
tracks images by account, quick-message ID and media revision. The preview can
use the original provider URL immediately and prefers the signed R2/S3 copy
after capture. If the image is unavailable, the title and keyword are still usable.
Apply the additive media owner enum migration through the approved deployment
workflow before using the archive.

Auto-replies show the Business account's provider-reported status, audience,
time fields and recurrence. The settings warn that native replies can run
alongside ChatbotX Flow or AI replies. Auto-reply creation and editing require
device-side verification of the schedule and recurrence semantics.

Use `GET` and `PATCH /v1/zalo-accounts/{accountId}/native-replies` with the
`channels` scope. Read with `kind=readQuickMessages` or `kind=readAutoReplies`
and use the returned offset and snapshot version for pagination. Explicitly
confirm removals and inspect uncertain writes by their original command ID at
`GET /attempts/{commandId}` under the same path. Use
`ZALO_ACCOUNT_NATIVE_REPLIES_ACCOUNT_IDS` only to restrict supported writes.
ChatbotX saved replies, Flow and AI settings are separate.

## Friend sync and safe status

Apply the additive `ZaloAccountUserProfile` migration through the approved
deploy workflow before deploying profile and friend-event consumers. The
Inbox loads a Zalo profile when an agent opens the direct contact panel
or an authorized group sender popover. The profile uses account-scoped
observations and refreshes with a short cooldown. It keeps the original Zalo
name and account display name separate from CRM contact edits. A public phone
number is provider-reported and unverified, and requires the appropriate
contact permission. Use `zaloAccounts.getContactProfile` with the selected
conversation and ContactInbox to read the same data through the API.

`POST /v1/zalo-accounts/{accountId}/friends/sync` imports up to 500 provider
entries per page, in sequential transactions of 100. Follow `nextCursor` with
a new command ID until complete. UID is account-scoped; updates fill missing
profile fields and missing friends are never deleted. Each newly created person,
ContactInbox, import ledger and durable contact counters commit together. A
revision-fenced cache outbox recovers invalidation after crashes without counting
twice. Imports emit no customer-created/activity automation and consume no MAC.

### Contact lookup, relationships, and presence

Contact operations are available for authorized account managers by default.
Deployments can restrict access to specific internal account IDs through
`ZALO_ACCOUNT_CONTACT_OPERATIONS_ACCOUNT_IDS` or set it to `false` to suspend
access. Public operations require the `channels` token scope. Phone and username searches are deliberate and bounded.
Select a returned contact with its five-minute, account-scoped selection token.
Opening a direct conversation uses that account's existing Inbox contact or
quietly creates one for the selected verified UID. A new contact updates the
usual contact counters without consuming MAC, emitting automation, or sending a
message.

Incoming requests reflect retained, observed friend events. Other relationship
lists reflect the provider response. Missing rows do not establish removal.
Presence is read on demand, stays fresh for 30 seconds, and exposes only the
online, offline, hidden, or unknown state for that account. Missing bulk entries
are unknown, and hidden and unknown entries omit the last-online timestamp.

Keep the same `commandId` when recovering a missed response from a relationship
write. The claim is retained for 24 hours. If a result is `unknown`, inspect the
current provider state or relationship list before choosing a new action. Redis
must be available to claim a write. With an explicit allowlist, remove the account ID to stop new lookups, presence
and relationship operations. Use `false` to suspend these operations globally.

Public paths are under `/v1/zalo-accounts/{accountId}/contacts`. Use `POST /lookup`,
`GET /relationships`, `POST /open-conversation`, `POST /friend-request-status`,
`POST /presence`, and `POST /relationship-actions`. The corresponding CLI
commands are in `zalo-accounts:contacts`.

`GET /v1/zalo-accounts/{accountId}/status` exposes Connection state, gateway
availability, capabilities and friend/group/label sync summaries. Availability
means a current lease exists, not a provider health guarantee. It never returns
authorization, operation tokens or gateway fencing identifiers.

Optional `runtime` is null for old rows. `socketOpen=true` requires a matching
lease and durable fence/epoch/attempt/sequence, with a sample no older than 60
seconds. Missing, expired or mismatched samples return an unverified socket;
Redis failure returns unavailable gateway/unknown freshness while preserving
durable context. `lastLifecycleAt` describes state transitions; `lastEventAt`
describes the latest SDK event and may be null. Silence does not prove a
disconnect. See the [safe status projection](../packages/business/src/zalo-account/service.ts).

Unexpected normal/network closes use finite backoff with jitter. Duplicate
connection 3000 and kick 3003 require manual intervention through a durable hold;
they do not by themselves prove revoked authorization. Transient/unknown login
errors do not force QR reauthorization, and an isolated error after open does
not start another socket. A new explicit QR authorization can recover a held
account. See [runtime policy](../apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts).

Cookie changes observed after a verified open use encrypted authorization
refresh with ciphertext compare-and-swap. This prevents an old runtime refresh
from replacing a newer same-UID QR authorization. Unchanged cookies cause no
write; no `getContext` export or `keepAlive` polling is introduced. Recovery
rechecks current ownership, Connection eligibility and holds before login.
See [authorization persistence](../packages/business/src/zalo-account/runtime-state.service.ts).

Recovery runs in bounded cursor passes (at most 50 accounts within a 30-second
budget), continuing later instead of blocking readiness on all accounts. One
coalesced recovery continuation owns restart work; login admission permits at
most two simultaneous starts per gateway. Held accounts are skipped. These
limits bound local work; they are not provider rate limits or a promise that
all accounts recover within 30 seconds. See [gateway startup/recovery](../apps/zalo-account-gateway/src/main.ts).

## Native labels and ChatbotX tags

Zalo labels are an account-wide versioned document. Sync maps provider label
definitions through `TagChannel(channelType=zaloAccount,
integrationId=accountId)` and applies assignments to existing direct threads
and explicitly provisioned group anchors in the owning Inbox. It never creates
member Contacts. Group tagging uses a quiet service and does not emit customer
activity, lead events or MAC.

The worker queues label reconciliation after verifying the current connection
and socket. Reconnect and scheduled reconciliation share one account job per
five-minute window. Setting `ZALO_ACCOUNT_LABEL_RECONNECT_SYNC_ENABLED=false`
pauses only reconnect-triggered reconciliation.

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
- `POST /v1/zalo-accounts/{accountId}/labels/queue-sync`
- `GET /v1/zalo-accounts/{accountId}/labels`
- `PATCH /v1/zalo-accounts/{accountId}/labels/{labelId}/definition`
- `GET /v1/zalo-accounts/{accountId}/groups/{groupId}/tags`
- `PATCH /v1/zalo-accounts/{accountId}/groups/{groupId}/tags`

Whole-document writes are fenced by an operation token/version/hash. Unknown
writes remain inspect-only until reconciliation; unconfirmed detach mappings
are retained. Missing or incomplete snapshots do not erase assignments. The
settings UI reports conflict/unknown/partial states rather than implying success.

The native label panel displays the provider's order, color and matching CRM
tag. A successful sync time reflects completion of reconciliation, including
all local batches. The label panel queues a sync once per account and shows its
progress. Editing existing definitions is available by default. Restrict the
accounts with `ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS` in the Builder and gateway.
Creation and deletion require provider evidence for ID allocation and assignment
semantics.

## Database rollout

The migration chain includes these generated changes; the implementation
workflow does not apply migrations:

- `packages/database/drizzle/20261119161633_zalo-account/`
- `packages/database/drizzle/20261120060156_zalo-account-groups/`
- `packages/database/drizzle/20261121024313_zalo-account-group-inbox/`
- `packages/database/drizzle/20261121055141_zalo-account-message-operations/`
- `packages/database/drizzle/20261128114017_add_zalo_account_group_administration/`
- `packages/database/drizzle/20261128123854_add_zalo_account_quick_message_media/`
- `packages/database/drizzle/20261128124923_enable_zalo_account_group_messaging_defaults/`

Inspect and apply them in order only after explicit approval. Until the required
schema exists in a target environment, its database-backed tests and live channel
operation remain a rollout gate; unit/contract/type checks do not replace
migration approval.

The group Inbox migration adds the immutable person/group discriminator,
anchor references, policy defaults/epochs, durable identity and kind-aware
contact-stat triggers. The operations migration adds receipt/reaction/attempt
enums and tables, friend import/cache ledger, operations summaries, Wait audience,
identity tombstones/recovery index and the reserved-source constraint. FKs have
leading indexes and purge drains the new children before account/workspace rows.

Apply the additive migrations **before deploying this code**: normal Contact
and account selects read the new columns. The defaults migration enables group
traffic for existing accounts and accessible groups and advances the changed
policy epochs. Automation stays disabled by default.

## Retained originals and recall tracking

Zalo Account recall changes only the exact account/thread/message tuple. It retains
Message text, Attachment records and already stored object bytes. Replies remain
independent messages; quoted originals are removed from ordinary projections.
Direct and group recall-before-original use durable intent and a stable placeholder;
a late original fills that tuple without restarting automation. Receipt/reaction
latest-state retention remains 90 days. Recall/original data has no new automatic
TTL; explicit contact/account/workspace purge still wins.

Ordinary list/detail/sidebar/realtime/translation projections remove recalled or
locally hidden bodies, filenames, provider URLs and raw payloads. The Inbox shows
distinct recalled/local-hidden labels. Loaded state keeps a monotone fence against
late pages and echoes. Existing ordinary media proxy tokens are rejected after
recall/hide. URLs or bytes already issued to a client cannot be revoked instantly.

**View saved content** fetches on demand after the existing conversation ACL and
exact workspace/account/Inbox/thread binding checks. Reads work after disconnect
or group-policy disablement. Signed links are issued only for objects already in
R2/S3, expire after 60 seconds, and never fall back to provider URLs. Missing
originals return `notCaptured`; files return `not_archived`/`unavailable` honestly.
Media ingestion (checklist P0 · 2) is separate. Live-message capture offers its
committed asset references to the existing bounded transfer queue immediately.
Full/unavailable queues retain the durable intent for scheduled recovery; profile
and backfill dispatch remain scheduled. Transfer concurrency and backlog limits
are unchanged. Pending/downloading images show a processing state until an
authorized stored image or preview is available. Query data and local download links
are cleared on dialog close or tuple change; reopen authorizes again. Audit writes
are best effort and record access/link issuance, not completed download, with no
message body, filename, storage path, or signed URL.

All procedures require the `inbox` token scope and normal conversation access:

| Method | Suffix under `/v1/zalo-accounts/{accountId}/conversations/{conversationId}` | Result |
| --- | --- | --- |
| GET | `/messages/{messageId}/capabilities` | Native gate and own-message eligibility |
| GET | `/messages/{messageId}/saved-content` | Saved original and attachment availability |
| GET | `/messages/{messageId}/saved-content/attachments/{attachmentId}` | Authorized stored-only URL |
| POST | `/messages/{messageId}/hide-locally` | Local hide; no Zalo call |
| POST | `/messages/{messageId}/recall` | Verified own-message undo attempt |
| POST | `/messages/{messageId}/delete-on-zalo` | Delete only for the connected account |
| POST | `/delete-on-zalo` | Clear provider history through the selected immutable boundary |
| GET | `/message-operations/{attemptId}` | Durable status; never replays |

Message targets require exact `createdAt` from `messages.list`. Native mutations
require a stable `commandId`; changed input with the same ID conflicts. Native
outcomes are `pending`, `dispatched`, `applied`, `failed` or `unknown`. A durable
main-DB CAS admits one provider call even after Redis dedupe expires. Unknown or
dispatched attempts must only be inspected. Provider delete-only-me and deleteChat
retain all CRM data and do not fabricate a recall marker. DeleteChat confirmation
pins the selected boundary so newer incoming messages do not widen the operation.
Read-only tokens cannot mutate; expired-owner deletion exceptions do not grant
read-only tokens write access. Scheduled workspace deletion still blocks mutation.

Native message operations use exact targets and confirmation rules. A numeric
SDK response without verified provider evidence remains `unknown`, even when
the operation was dispatched. Use
`ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED=false` to pause dispatch while
keeping the retained history and ledger.

The additive migration
`packages/database/drizzle/20261123081746_add_zalo_account_recall_tracking/migration.sql`
creates only two main-DB metadata tables; it changes no Message/shard schema and
copies no bodies/blobs. It has been generated, not applied. Obtain separate
approval before applying it. Deploy schema, safe readers/lifecycle/recovery, then
UI in that order. Existing group recovery hosts recall repair
with caps (25 intents, 2 ranges/50 candidates per lookup) and a deadline; no new
queue, scheduler or full-history backfill was added. Stable Zalo placeholders select a registered primary covering their reserved timestamp, so delayed creation remains routable after subsequent shard rotations; non-Zalo stable creation retains its existing write route. Out-of-range historical rows
that cannot be safely updated remain pending rather than falsely acknowledged.

Rollback starts by disabling native dispatch. Preserve safe projections and
ledger tables while bounded repair drains pending work. Do not revert to readers
that expose retained originals, and do not automatically drop retained data.

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

### Connection/socket readers and producers

The connection/socket/session update uses existing operations JSON and Redis
snapshots; it introduces no new table, column or migration. Deploy compatible
readers first: SDK/worker event schemas and handlers, realtime schema/delivery,
and status projection. Then enable gateway producers, followed by the UI.
Strict old event readers can reject the new diagnostic variant and fields;
producer-first rollout is unsupported.

Rollback reverses this dependency: stop/drain new gateway producers and queued
new-format events before downgrading SDK/worker/realtime readers. UI/status
rollback can retain polling and tolerate absent runtime data. Preserve existing
operations JSON, encrypted authorization and Connection state.

Automated SDK/runtime, business/PostgreSQL and UI/contract evidence is recorded
in the [implementation reports](../plans/261123-0459-zalo-account-connection-socket-session-tdd/reports/implementation.md)
and [business proof](../plans/261123-0459-zalo-account-connection-socket-session-tdd/reports/business-implementation.md).
These do not certify live Zalo QR/open/close/kick/cookie behavior or
Redis/gateway/worker restart staging. Track that remaining end-to-end gate in
the [Zalo Account checklist](./zalo-account-checklist.md).
