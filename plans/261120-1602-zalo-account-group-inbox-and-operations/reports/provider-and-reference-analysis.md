# Zalo Account Group Inbox and Operations: Provider and Reference Analysis

Date: 2026-11-20
Scope: checklist workstreams 10–16 (group Inbox identity/content, advanced message lifecycle, attachments/replies, group/member/profile sync, reliability boundaries, and validation gates)
Reference package: `zca-js` 2.1.2, as installed in ZaloCRM

## Executive result

The pinned SDK can carry a substantially richer group surface than the current
ChatbotX Zalo Account contract: group messages and history, mentions, typing,
delivered/seen batches, reactions, undo packets, group events, group details,
member profiles, and profile lookup are all represented in the local SDK. The
current ChatbotX gateway intentionally drops most of that surface. It emits
only a minimal `group_activity` event, while the public SDK contract has only
group metadata and controlled group sending. This is a deliberate boundary in
the current product documentation, not evidence that the provider cannot send
or receive group messages (`docs/zalo-account.md:117-137`,
`packages/sdk/src/lib/zalo-account.ts:195-214`,
`packages/sdk/src/lib/zalo-account.ts:493-574`).

The smallest stable contract for a first Full Group Inbox is:

1. Add a group-specific inbound message event, preserving the provider group
   ID, both provider message IDs, sender UID, sender display name, `isSelf`,
   timestamp, supported text/image/file content, same-group quote metadata, and
   mention spans. Use an account/workspace/group/message scoped dedupe key. Do
   not route a group message through the direct-message peer/contact model.
2. Keep outbound group sending to exactly one text payload or one controlled
   image/file attachment, with a caller-supplied stable command ID. Permit a
   quote only when the quoted message is in the same group and both IDs are
   known. Preserve group mentions only after the fixture/live gates below pass.
   This is narrower than what `zca-js` can technically upload, but matches the
   already documented ChatbotX safety boundary.
3. Add lifecycle events as group-shaped, best-effort records rather than
   pretending that group receipts equal direct receipts: typing is ephemeral;
   delivered/seen carry per-member arrays; reactions are keyed by target
   message and reactor; undo/delete resolve the nested target IDs. Enforce
   monotonic receipt transitions and idempotent reaction/delete handling.
4. Make group sync explicitly partial-safe. `getAllGroups` provides IDs and
   versions; details and members require follow-up calls, the member roster may
   be incomplete, and a missing/empty response must not delete known groups or
   members. Keep group rows provider-scoped and policy-controlled until the
   Inbox behavior is live-validated.

Do not start with a generic cross-provider group framework, full group
administration, rich media/album parity, edits, or automation triggers. The
provider is unofficial and its event shapes and server behavior are not a
stable product API; the ZaloCRM implementation is useful behavioral evidence,
but its policies are not provider guarantees.

## Contents

- [Evidence and authority](#evidence-and-authority)
- [1. Group identity, sender, and mention contract](#1-group-identity-sender-and-mention-contract)
- [2. Outbound, reply, and attachment boundaries](#2-outbound-reply-and-attachment-boundaries)
- [3. Delivered, seen, typing, reaction, undo, and delete](#3-delivered-seen-typing-reaction-undo-and-delete)
- [4. Group, member, profile, and history synchronization](#4-group-member-profile-and-history-synchronization)
- [5. Current ChatbotX gap and architectural implications](#5-current-chatbotx-gap-and-architectural-implications)
- [6. Unreliable or out-of-scope capabilities](#6-unreliable-or-out-of-scope-capabilities)
- [7. Fixtures and live-account validation gates](#7-fixtures-and-live-account-validation-gates)
- [Recommendation and acceptance boundary](#recommendation-and-acceptance-boundary)
- [Limitations](#limitations)

## Evidence and authority

The sources have different authority and must not be conflated.

| Source | Authority | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Installed `zca-js` 2.1.2 declarations and implementation | Strongest local provider evidence | Names, fields, method arguments, listener dispatch, response nesting, and local validation | That the current Zalo server always emits every field, permits every operation, or preserves behavior over time |
| ZaloCRM listener/routes/workers | Reference behavior and product policy | How one product normalizes, dedupes, enriches, retries, and presents the SDK surface | A provider guarantee; its permissions, limits, sweeps, and UX decisions are application choices |
| ChatbotX docs, SDK schemas, gateway, integration, worker | Binding architecture for this project | Current public contract, safety boundary, ownership/streaming rules, and intentional exclusions | New group-Inbox support; most group event payloads are currently discarded |

The pinned reference is confirmed as `zca-js` version 2.1.2 and describes itself
as an unofficial Zalo API (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/package.json:1-6`). The prior research report correctly treats it as a provider oracle and ZaloCRM as a behavior reference, not an architecture template; it also records that there is no live-account evidence in that report (`plans/261120-0350-zalo-account-channel-messaging/reports/zalocrm-reference.md:29-48`, `plans/261120-0350-zalo-account-channel-messaging/reports/zalocrm-reference.md:570-598`).

## 1. Group identity, sender, and mention contract

### Provider fields and exact identity

The SDK has one thread wrapper for both direct and group messages:

- `ThreadType.User = 0` and `ThreadType.Group = 1` (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Enum.d.ts:1-4`).
- `TMessage` carries `msgId`, `cliMsgId`, `uidFrom`, `idTo`, `dName`, `ts`,
  `msgType`, `content`, `quote`, and status/extension fields
  (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Message.d.ts:15-50`).
- `TGroupMessage` extends that message with `mentions: TMention[]`; each
  mention is `{uid, pos, len, type}` where `type` is `0 | 1`
  (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Message.d.ts:51-70`).
- The listener wraps a group message as `{type, data, threadId, isSelf}`; the
  wrapper's `isSelf` identifies the logged-in account's own echo
  (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Message.d.ts:71-91`).

For a normalized inbound group message, the stable identity is therefore:

```text
accountId + threadType="group" + threadId=providerGroupId + providerMessageId=msgId
```

`clientMessageId=cliMsgId` must be retained beside `providerMessageId`, not
used as a replacement. ZaloCRM explicitly keeps both because undo requests
need both and older messages without a client ID cannot be undone reliably
(`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:616-725`, `<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:765-796`). The prior reference report also warns that both IDs are required for durable echo/dedupe and undo (`plans/261120-0350-zalo-account-channel-messaging/reports/zalocrm-reference.md:115-135`, `plans/261120-0350-zalo-account-channel-messaging/reports/zalocrm-reference.md:444-505`).

The actor identity is `data.uidFrom` for an inbound group message. `dName` is
an envelope hint, not a durable profile. ZaloCRM first uses it, then resolves a
profile for the sender and resolves group metadata separately
(`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:616-675`). For a self echo, keep the group as the conversation/thread and the logged-in account UID as the sender; do not turn the recipient group ID into a direct-message peer.

Recommended group event shape (names are intentionally Zalo Account-specific,
not a speculative provider-neutral abstraction):

```text
route: { workspaceId, accountId, inboxId }
kind: "group_message"
payload: {
  providerGroupId,
  providerMessageId,       // msgId; required
  clientMessageId?,        // cliMsgId; preserve when present
  senderId,                // uidFrom; required
  senderName?,             // dName/profile snapshot; non-authoritative
  timestampMs,             // normalized ts
  msgType,
  isSelf,
  text?,
  attachments: image/file only,
  quote?,
  mentions?: [{ uid, pos, len, type }]
}
```

This is a new group contract; it should not be forced through
`zaloAccountDirectMessageSchema`, which hard-codes `threadType: "user"` and a
direct `recipientId` (`packages/sdk/src/lib/zalo-account.ts:149-172`). The
current gateway's group path demonstrates the exact missing data: it emits
only `{kind: "group", threadId, providerMessageId}` and drops sender, content,
mentions, quote, and status fields (`apps/zalo-account-gateway/src/runtime/provider-message.ts:148-202`). The runtime port likewise accepts only a minimal group callback (`apps/zalo-account-gateway/src/runtime/ports.ts:83-112`).

### Mention transport and normalization

The SDK's direct source is `message.data.mentions`. ZaloCRM has observed a
second server encoding in `message.data.propertyExt.ext`, either already an
object or a JSON string, with the same `{uid,pos,len,type}` array. It accepts
the direct array first, then the extension fallback, and drops empty UID or
non-positive length entries (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:332-375`).

For a first group Inbox:

- preserve `uid`, zero-based `pos`, `len`, and `type` exactly; do not rewrite
  spans into display-name text;
- parse the extension fallback only when it is valid JSON/object data;
- retain the raw `msgType` and raw message content for unsupported payloads in
  a bounded diagnostic record, but do not expose arbitrary extension fields as
  public API;
- treat `uid = "-1"`/`type = 1` (all-members mention, as accepted by the SDK
  sender) as provider-specific and validate it before enabling outbound
  mentions (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/sendMessage.js:121-142`).

### Dedupe and event ordering

The dedupe key must include account and group scope, not just `msgId`; retries,
old-message backfills, and two accounts observing the same provider group can
otherwise collide. ChatbotX already requires provider/account/thread/message
identity in the direct pipeline (`docs/zalo-account.md:105-108`) and uses
scoped Zalo IDs for direct messages (`integrations/zalo-account/src/message.ts:14-19`). Apply the same rule to group rows.

`msgId` and `cliMsgId` are not guaranteed to arrive together in every history
path. If `msgId` is missing, reject the event as unidentifiable. If only
`cliMsgId` is missing, persist the message but mark undo/delete as unavailable
until a later provider event supplies the second ID; never invent one.

## 2. Outbound, reply, and attachment boundaries

### Provider send contract

`api.sendMessage(message, threadId, type?)` accepts text, quote, mentions, and
attachments. The SDK response is nested: `message: {msgId} | null` plus an
attachment list that may contain additional message IDs
(`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/sendMessage.d.ts:2-18`). Group mentions are validated and serialized only for group targets; the sender checks position/length and total mention span before submitting (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/sendMessage.js:121-142`). Group requests use the group ID/grid path (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/sendMessage.js:165-228`).

The provider can technically upload more than ChatbotX should promise: local
paths or buffers, images, video, generic files, GIFs, albums, and asynchronous
upload callbacks are implemented in the SDK (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/sendMessage.js:230-399`). A caption/media request can split into multiple provider messages, and
albums produce multiple IDs/layout metadata (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/sendMessage.js:410-451`; prior report `plans/261120-0350-zalo-account-channel-messaging/reports/zalocrm-reference.md:137-186`). This makes a broad “one user request = one message” API unsafe.

ChatbotX's current group endpoint intentionally narrows this to exactly one
text or one supported attachment and requires a stable `commandId`
(`docs/zalo-account.md:128-137`). The public outbound schema also forbids
text+attachment combinations and caps one attachment
(`packages/sdk/src/lib/zalo-account.ts:256-273`). Keep that boundary for group
Inbox v1. It is a product safety policy, not a claim that the provider lacks
captions or albums.

### Safe attachment contract

The current SDK attachment schema allows only `image` or `file`, an HTTPS/HTTP
URL, and optional name/MIME/size (`packages/sdk/src/lib/zalo-account.ts:126-135`). The direct gateway extracts provider photo/image URLs (`oriUrl`, `hdUrl`, `url`, `href`, thumbnail variants) and file/document URLs, accepting only HTTP(S) URLs (`apps/zalo-account-gateway/src/runtime/provider-message.ts:81-120`). Outbound direct media is downloaded through the controlled HTTPS/allowlist/redirect/size/type path and materialized temporarily, rather than exposing arbitrary local paths or provider URLs (`docs/zalo-account.md:110-115`; `integrations/zalo-account/src/message.ts:114-156`). Reuse this exact safety path for group sends.

Recommended v1 attachment boundary:

| Allowed | Required handling |
| --- | --- |
| One image | HTTPS-controlled download; preserve MIME/name/size; expect nested provider message/attachment IDs |
| One generic file | Same controlled download; no local-path API; reject unsupported/unknown type explicitly |
| Text only | One provider message; use the stable command ID for command/result correlation |

Do not expose sticker, voice, video, card, poll, forward, GIF, album, or
arbitrary provider attachment objects in the first contract. The direct product
documentation explicitly rejects those classes (`docs/zalo-account.md:110-115`).

### Reply/quote contract

The SDK quote type includes owner ID, client/global message IDs, client message
type, timestamp, content, attachment, sender display, and TTL
(`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Message.d.ts:51-70`). The sender builds qmsgOwner/qmsgId/qmsgCliId/qmsgType/qmsgTs/qmsg and rejects known unsafe quote types such as `webchat` and `group.poll` (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/sendMessage.js:165-228`).

The ZaloCRM route constructs a reply quote from the original remote message,
requiring a provider message ID and sender UID, and uses the original Zalo ID
for both `msgId` and `cliMsgId` when that is the only durable reference
(`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/chat-routes.ts:88-116`). This is an application fallback, not evidence that every message has equal IDs.

Group replies should require:

- a known source message in the same provider group;
- `providerMessageId`, `clientMessageId` when available, `senderId`,
  `msgType`, and normalized timestamp;
- a supported source content class (text/image/file);
- no cross-group or direct-to-group quote conversion;
- no quote of a provider type that the SDK explicitly rejects.

If any required quote identifier is absent, send the new message without a
quote only when the caller explicitly requested a non-reply; do not silently
quote a guessed ID.

## 3. Delivered, seen, typing, reaction, undo, and delete

The SDK emits all of these event families, but group payloads are not shaped
like direct payloads. `listen` declares `typing`, `seen_messages`,
`delivered_messages`, `reaction`, `old_reactions`, `undo`, and `group_event`
alongside messages and history (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.d.ts:28-45`). The following table separates SDK truth from ZaloCRM interpretation and the recommended ChatbotX boundary.

| Capability | Pinned SDK fact | ZaloCRM behavior/policy | Smallest ChatbotX contract |
| --- | --- | --- | --- |
| Delivered | User payload has `msgId`, `realMsgId`, `deliveredUids`, `seenUids`, `mSTs`; group adds `groupId` (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/DeliveredMessage.d.ts:2-27`). Listener dispatches user and group batches (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.js:321-347`). | Direct path updates delivered; it detects merged seen flags in delivered events (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:518-607`). | Emit group receipt with target message ID, group ID, `deliveredUids`, optional `seenUids`, `seen` flag, and provider timestamp. Never reduce a group array to one direct `recipientId`. |
| Seen | User payload has `idTo`, `msgId`, `realMsgId`; group has `msgId`, `groupId`, `seenUids` (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/SeenMessage.d.ts:2-25`). | Direct path treats the event as an anchor and sweeps prior own messages (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:455-516`). | Preserve group anchor and seen-member IDs. Apply only monotonic per-message/per-member state; sweeping is an explicit policy requiring live validation. |
| Typing | User has `uid`, `ts`, `isPC`; group adds `gid`, wrapper has `threadId`/`isSelf=false` (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Typing.d.ts:2-23`). Listener maps typing/gtyping (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.js:302-319`). | ZaloCRM forwards both types but comments that tested group/user typing showed no dots; the SDK notes group typing may be absent for a two-person group (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:431-453`; `<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.js:302-319`). | Best-effort ephemeral event `{groupId, actorId?, ts, isPC?}` with client-side expiry. Never use typing as durable message state or automation trigger. |
| Reaction | Reaction includes target `rMsg` entries (`gMsgID`, `cMsgID`, `msgType`), reactor `uidFrom`, icon/type/source, timestamp, and group wrapper fields (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Reaction.d.ts:58-85`). Live and old reaction commands are dispatched (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.js:265-289`). | ZaloCRM resolves target by group/message IDs, upserts a reactor/emoji row, and treats empty icon or negative type as removal (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:31-155`). It marks self-echo expectation before the provider call (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/chat-operations-routes.ts:168-251`). | Add a group reaction event keyed by `(groupId,targetProviderMessageId,reactorUid,emoji/type)`; upsert idempotently; support provider removal semantics. Do not make reactions a message-send or workflow trigger in v1. |
| Undo | Listener treats a message packet with `content.deleteMsg` as an undo, skips normal message emission, and distinguishes user/group (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.js:175-211`). Undo wrapper contains `data`, `threadId`, `isSelf`, `isGroup` (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Undo.d.ts:1-33`). | ZaloCRM says packet `data.msgId` is the undo packet ID; original target is nested `data.content.globalMsgId`, falling back to `cliMsgId` (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:765-796`). | Normalize target IDs from nested content; retain packet ID only for diagnostics. Delete/tombstone by target ID, idempotently, and retry lookup when the original message is not yet persisted. |
| Delete | `deleteMessage` requires target `cliMsgId`, `msgId`, `uidFrom`, thread ID, and `onlyMe`; private “delete for all” is rejected, while group delete may use the group path (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/deleteMessage.d.ts:5-14`; `<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/deleteMessage.js:17-50`). | ZaloCRM uses provider delete/undo for self/group and local tombstones; its route requires remote IDs and differentiates only-me (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/chat-operations-routes.ts:301-325`). | Keep delete as an explicit group operation with provider result/error. Do not promise delete-for-all for arbitrary group messages or direct messages. |

### Ordering and convergence rules

The following rules are required even if the first implementation emits fewer
event kinds:

1. **Echo before result, no replay.** ZaloCRM records the expected self echo
   before calling `addReaction`/send paths because the provider echo can race
   the API result (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/chat-operations-routes.ts:168-251`). ChatbotX must correlate by provider IDs and command ID, not assume response-before-event ordering.
2. **Receipts are monotonic.** For a target member, `read/seen` implies
   `delivered`; never regress `seen` to `delivered` because a delayed batch
   arrived. Group arrays may be partial, so merge by member UID and preserve
   the provider timestamp where present.
3. **Merged delivered/seen is valid.** The reference implementation observed
   `delivered_messages` with `seen=1` or nonempty `seenUids` instead of a
   separate seen event (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:518-545`). Treat that as
   both states, but keep the behavior behind a fixture/live gate rather than
   claiming every account emits it.
4. **Seen anchors are policy, not a universal provider contract.** ZaloCRM
   sweeps older self messages up to the anchor in direct conversations
   (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:455-516`). The SDK types do not state that a
   group seen anchor should sweep every sender's message. For groups, update
   only the explicit `seenUids` target unless live evidence justifies a more
   expansive rule.
5. **Undo resolves the nested target.** Never tombstone `data.msgId` from the
   undo packet without checking `content.globalMsgId`/`content.cliMsgId`.
6. **History and live events dedupe together.** `old_messages`, reconnect
   backfills, and live message events can overlap. Use the same scoped message
   identity for all paths and do not advance a cursor until persistence is
   acknowledged. The SDK supports old-message requests with cursors
   (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.d.ts:83-99`; `<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.js:290-301`).
7. **Provider send failure is unknown.** ChatbotX documentation says a failed
   provider send/whole-label write must not be automatically replayed, because
   the provider may have accepted it (`docs/zalo-account.md:31-35`). This is
   especially important for split media/caption sends.

## 4. Group, member, profile, and history synchronization

### Group list and details

`getAllGroups` returns a version and `gridVerMap`, not guaranteed display
details (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/getAllGroups.d.ts:1-7`). Details are fetched with `getGroupInfo`, whose response maps IDs to `GroupInfo`, `memVerList`, and pending/removed/unchanged groups (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/getGroupInfo.d.ts:1-15`). The group model includes name, avatar, version, member IDs, administrators, member counts, settings, visibility, and e2ee/extra fields (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/Group.d.ts:83-125`).

The ZaloCRM list route chunks detail lookups in groups of 50 and falls back to
the group ID when details are missing (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/group-routes.ts:17-57`). That chunk size is a reference implementation choice aligned with the SDK request shape, not a public ChatbotX guarantee. Current ChatbotX stores a name/avatar/count/version group row and has explicit send policy (`packages/sdk/src/lib/zalo-account.ts:195-204`; `packages/business/src/zalo-account/group.service.ts:24-127`).

Safe sync rules:

- treat `gridVerMap` as the authoritative current ID/version snapshot, then
  fetch details in bounded chunks;
- upsert non-empty fields; do not replace a known avatar/name with an empty
  value from a partial response;
- mark removed/inaccessible groups non-sendable and preserve the last known row
  for audit/history; do not delete on one failed or partial sync;
- keep `sendEnabled=false` until policy and live behavior are approved, as the
  current docs require (`docs/zalo-account.md:117-126`);
- attach every group row to its workspace/account, never to a globally shared
  Contact.

### Member roster and profile enrichment

`getGroupMembersInfo` accepts member IDs and returns profile records including
display name, Zalo name, avatar, account status/type, last update time, global
ID, and ID (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/getGroupMembersInfo.d.ts:1-17`). `getUserInfo` returns richer changed/unchanged profiles and has key variants such as `uid`/`uid_0` (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/getUserInfo.d.ts:1-8`; `<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/getUserInfo.js:14-43`).

The ZaloCRM scanner reports important incompleteness: real responses may leave
`memberIds` empty; roster IDs may instead be in `memVerList` and
`currentMems`; `hasMoreMember` or a count below `totalMember` means the scan is
truncated because pinned zca-js has no paginated roster API
(`<HOME>/Documents/Github/ZaloCRM/backend/src/workers/group-scan-worker.ts:110-212`). Its safe behavior is to mark a snapshot partial rather than claim a complete roster, enrich profiles in chunks, and continue after one group/member failure (`<HOME>/Documents/Github/ZaloCRM/backend/src/workers/group-scan-worker.ts:1-16`, `<HOME>/Documents/Github/ZaloCRM/backend/src/workers/group-scan-worker.ts:37-104`, `<HOME>/Documents/Github/ZaloCRM/backend/src/workers/group-scan-worker.ts:214-245`).

Profile names are hints and can differ by account. ZaloCRM caches profile
lookups for five minutes, prefers `zaloName`/`displayName`, and stores optional
avatar/phone/globalId metadata (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:249-306`). This is product enrichment policy. ChatbotX should use a sender UID as the durable member key, keep the latest non-empty profile snapshot, and avoid global contact merging until an explicit product decision covers privacy and identity collisions.

### Group events and history

The SDK defines group events for join/leave/remove/block, settings, name/avatar
updates, admin changes, links, pins, board/reminder updates, and related
operations (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/models/GroupEvent.d.ts:3-66`). ZaloCRM uses selected group events to refresh metadata and does not yet implement system-message persistence for every event (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:960-981`). Current ChatbotX does not expose group events in its transport union; it coalesces group activity into a metadata refresh job (`apps/worker/src/events/zalo-account/handler.ts:165-183`, `packages/sdk/src/lib/zalo-account.ts:559-574`).

`getGroupChatHistory` returns `groupMsgs`, cursors, and a `more` flag, with a
default/count contract around 50 messages
(`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/getGroupChatHistory.d.ts:2-7`; `<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/getGroupChatHistory.js:14-35`). ZaloCRM limits first-connect backfill to 50 groups and 50 messages/group, and its polling backup handles 20 active groups per five-minute cycle (`<HOME>/Documents/Github/ZaloCRM/backend/src/workers/zalo-history-backfill.ts:1-20`, `<HOME>/Documents/Github/ZaloCRM/backend/src/workers/zalo-history-backfill.ts:224-313`; `<HOME>/Documents/Github/ZaloCRM/backend/src/workers/zalo-message-sync.ts:1-16`, `<HOME>/Documents/Github/ZaloCRM/backend/src/workers/zalo-message-sync.ts:39-105`). These are sensible bounded reference policies, not SDK limits to expose without an operations decision.

Recommended sync state machine:

```text
snapshot IDs/version -> bounded detail fetch -> bounded roster/profile fetch
       |                    |                         |
       +-- partial/error ---+--- keep last good -----+
                         -> complete only when every required page is known
```

Every run needs an account-scoped run ID/generation. A stale completion must
not overwrite a newer group/member version. This follows the existing gateway
lease/fence/epoch design, while the provider-facing group data remains
provider-specific (`docs/zalo-account.md:16-35`).

## 5. Current ChatbotX gap and architectural implications

The current design is intentionally not a Full Group Inbox:

- documentation calls groups provider-scoped resources “not Contacts or Inbox
  conversations” and says group activity only schedules a refresh
  (`docs/zalo-account.md:117-126`);
- the public SDK has direct message/status/undo events plus minimal group
  metadata/activity, but no group message/status/typing/reaction/undo/member
  events (`packages/sdk/src/lib/zalo-account.ts:149-214`, `packages/sdk/src/lib/zalo-account.ts:493-574`);
- the gateway normalizes direct text/image/file/quote only and emits minimal
  group activity (`apps/zalo-account-gateway/src/runtime/provider-message.ts:81-202`; `apps/zalo-account-gateway/src/runtime/zca-client.ts:48-177`);
- the integration and worker handle direct messages/status/undo, while group
  activity refreshes group resources and never enters the direct Inbox path
  (`integrations/zalo-account/src/message.ts:54-247`; `apps/worker/src/events/zalo-account/handler.ts:83-183`).

The implication is not “reuse the direct schema with `threadType=group`.” A
group Inbox needs a separate group conversation/message/participant contract,
because:

- a group has many sender UIDs and possibly per-member receipt arrays;
- `idTo` and `threadId` describe the group destination, not a direct peer;
- a group message can be self-authored while still belonging to the group;
- group metadata/member snapshots have partial/inaccessible states;
- group message history, live events, reactions, and undo may arrive through
  different paths.

The smallest implementation boundary is therefore a Zalo Account-specific
group event family in the gateway/worker, with explicit adapters into Inbox
storage. Keep direct-message handlers unchanged. Preserve the current group
resource API and `sendEnabled` policy while the new Inbox contract is behind a
capability/admission flag.

## 6. Unreliable or out-of-scope capabilities

### Keep out of the first stable contract

- **Unofficial/provider drift.** The package is unofficial; server fields,
  permissions, rate limits, and account restrictions can change. The prior
  report lists no live account/current-server verification
  (`plans/261120-0350-zalo-account-channel-messaging/reports/zalocrm-reference.md:570-598`).
- **Full group administration.** The SDK/reference app expose create, rename,
  member, admin, block, link, and approval operations, but provider permission
  semantics are account/role-dependent. Do not couple Inbox delivery to those
  operations; leave them out until each operation has a separately approved
  API and live gate (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/group-routes.ts:91-180`).
- **Rich media parity.** Video/GIF/album/voice/sticker/card/poll/forward
  support exists in pieces of the SDK, but can split messages, require
  asynchronous callbacks, or use unstable content shapes. The product's safe
  direct boundary explicitly rejects them (`docs/zalo-account.md:110-115`).
- **Edit messages.** The reference routes describe edit as CRM-only because
  zca-js has no true edit API (`<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/chat-operations-routes.ts:362-365`). Do not model an edit event.
- **Group typing as a guarantee.** The SDK can decode it, but its own listener
  comment says two-person groups may not emit it and ZaloCRM's live observation
  saw no typing dots (`<HOME>/Documents/Github/ZaloCRM/backend/node_modules/zca-js/dist/apis/listen.js:302-319`; `<HOME>/Documents/Github/ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:431-453`).
- **Group receipts as direct read status.** `seenUids`/`deliveredUids` are
  per-member and can be empty/merged. Do not collapse them to one read flag or
  use direct anchor-sweep semantics without live evidence.
- **Reactions as automation triggers.** Reaction events can be backfilled,
  duplicated, removed by empty icon/type, or arrive before the request result.
  Keep them presentation/state updates only in v1.
- **Global Contact identity.** A profile's `globalId` is useful enrichment, not
  permission to merge members across accounts/workspaces. Store account-scoped
  member identity first.
- **Unbounded backfill.** History APIs are cursor/batch based; use bounded
  recent history and explicit continuation, not an implicit full-account replay.
- **Cross-provider framework.** Do not generalize these fields into a shared
  “group” abstraction until at least two providers have the same semantics.
  The Zalo contract has provider-specific ID pairs, mentions, receipt arrays,
  and undo packets.

### Operational hazards to retain

The provider's sends are not safely replayable. Commands can be accepted while
the client sees a timeout or connection loss; captions/media may produce more
than one provider message. The current docs require explicit failure handling,
readiness/admission checks, bounded streams, and no automatic replay
(`docs/zalo-account.md:16-35`, `docs/zalo-account.md:173-183`). Any group Inbox rollout should keep
the existing lease/fence/epoch and poison-event handling rather than add a
second local retry loop.

## 7. Fixtures and live-account validation gates

The following gates are concrete enough for implementation planning. Fixtures
should use redacted payloads captured from the pinned SDK shape, and each live
gate should record the SDK version, account/device state, raw event kind, and
observed ordering. No production account is implied.

### Static contract fixtures

| ID | Fixture | Expected assertion |
| --- | --- | --- |
| G-01 | Inbound group text: `type=1`, `threadId`, `data.msgId`, `cliMsgId`, `uidFrom`, `idTo`, `dName`, `ts`, `msgType`, `isSelf=false` | Normalizes to one group message; group ID is the conversation; sender UID is actor; both IDs survive; dedupe key is account/group/message scoped. |
| G-02 | Self group echo with same fields and `isSelf=true` | Uses group conversation and logged-account sender; does not create a direct contact peer; correlates with the outbound command without duplicate persistence. |
| G-03 | Two messages sharing a provider message ID in different accounts/groups | Both persist; account/group scope prevents collision. |
| G-04 | Mentions in `data.mentions`, and fallback in `propertyExt.ext` as object and JSON string; invalid/zero-length entries | Direct form wins; fallback parses; invalid spans are dropped; `uid`, `pos`, `len`, `type` are preserved. |
| G-05 | Group quote with `globalMsgId`, `cliMsgId`, owner/sender, timestamp, content/msgType; quote missing client ID | Complete quote is emitted; missing ID is retained as unavailable and never fabricated. |
| G-06 | Image and file payloads with each URL variant; non-HTTP URL; unsupported msgType | Only safe HTTP(S) image/file attachments normalize; unsupported payload is explicit failure/diagnostic, not silently text. |
| G-07 | `sendMessage` response with nested text ID, attachment IDs, and a split caption/media response | Command result records every provider ID; no assumption of one provider message; no automatic retry after timeout. |
| G-08 | Group delivered batch with `deliveredUids`, `seenUids`, `seen=0/1`, `mSTs`; group seen batch with `seenUids`; duplicate/out-of-order batches | Merge per member; seen implies delivered; late delivered cannot regress seen; timestamp comes from provider where available. |
| G-09 | Typing user/group envelopes, including missing group event | Ephemeral event has group/actor/timestamp when available; absent event does not fail message processing or create durable state. |
| G-10 | Reaction add, duplicate, old-reaction replay, empty icon, negative type, self echo race | Upsert/remove is idempotent by target/reactor/emoji; target uses `rMsg.gMsgID/cMsgID`; response order is irrelevant. |
| G-11 | Undo packet where packet `data.msgId` differs from nested `content.globalMsgId`/`cliMsgId`; missing nested IDs | Tombstones nested target only; missing target is retryable/diagnostic, never deletes packet ID. |
| G-12 | Delete request: self/group only-me and all; private all-delete rejection | Provider capability/error is surfaced; no promise of delete-for-all for arbitrary member messages. |
| G-13 | `getAllGroups` with only `gridVerMap`; details in 50-item chunks; removed/unchanged/missing detail | IDs/version drive snapshot; details are bounded; missing detail does not erase known metadata. |
| G-14 | Group `memVerList` with `<uid>_<version>`, empty `memberIds`, `currentMems`, `hasMoreMember=true`, count below total | Roster is marked partial/truncated; profile enrichment chunks and continues; no false complete snapshot. |
| G-15 | Profile response keyed by `uid` and `uid_0`, unchanged profile, missing avatar/name | Correct key fallback; fill-only update; member identity remains UID-scoped. |
| G-16 | Group `old_messages` / `getGroupChatHistory` overlap, `more=true`, reconnect duplicate | Same identity/dedupe path handles live/history overlap; cursor advances only after persistence. |
| G-17 | Stale gateway callback after lease/fence/epoch change, malformed/oversized/unknown event | Stale callback cannot append accepted events; malformed/unsupported event is bounded/observable and does not poison the consumer. |

### Live staging gates

Use one controlled Zalo Account, one test group with at least three members,
and a second device/account where a receipt or reaction must be generated.

1. **Identity and echo:** send group text from another member and from the
   connected account; capture message, old-message, and reconnect paths. Verify
   `threadId`, `uidFrom`, `idTo`, `msgId`, `cliMsgId`, `dName`, `ts`, and
   `isSelf` exactly, including duplicate delivery.
2. **Mention and reply:** send a member mention and all-members mention; reply
   to text and image/file in the same group; verify span positions, quote IDs,
   and no cross-group quote acceptance.
3. **Safe media:** send one image and one file through the controlled download
   path. Record whether the provider returns one or multiple IDs and whether
   captions split. Do not enable richer media based on this test alone.
4. **Receipts:** with a second member's device open/closed, observe group
   delivered and seen batches, `deliveredUids`, `seenUids`, `seen`, and
   `mSTs`. Test delayed/reordered batches and confirm monotonic state. Verify
   whether the server emits one merged delivered/seen event or separate events.
5. **Typing:** test two-member and three-member groups, desktop/mobile if
   available, and reconnect. Treat no event as an expected best-effort outcome.
6. **Reaction:** add/remove the same reaction from another member and the
   connected account; reconnect to trigger old reactions; verify target IDs,
   reactor UID, duplicate delivery, and self-echo ordering.
7. **Undo/delete:** undo an own group message, attempt delete-for-all on an
   own message and another member's message, and test only-me behavior. Record
   exact provider error codes and any time window; do not infer permissions
   from ZaloCRM's route policy.
8. **Group changes:** rename group, change avatar, add/remove/leave a member,
   change admin/settings, and make a group inaccessible if the test account can
   safely do so. Verify group event, refresh, version, and non-sendable state;
   ensure partial responses do not erase last-known metadata.
9. **Roster/profile:** compare `memberIds`, `memVerList`, `currentMems`,
   `totalMember`, and `hasMoreMember`; resolve each member through
   `getGroupMembersInfo`/`getUserInfo`; record key variants and avatar URL
   behavior.
10. **History/backfill:** disconnect/reconnect, request old messages, and
    poll recent group history. Verify overlap dedupe, `more` cursor behavior,
    timestamp order, and that a missing top-level ID never creates a guessed
    group/message identity.
11. **Failure/admission:** inject timeout, closed socket, malformed payload,
    stale lease/fence, and command/result loss. Verify no auto-replay, no stale
    append, bounded diagnostics, readiness/admission behavior, and an explicit
    operator path to disable group sending.

### Rollout gate

The feature should remain disabled for production accounts until all of the
following are true:

- G-01–G-17 pass against redacted pinned fixtures;
- live gates 1–11 have observed payloads for the target account type and
  device setup, with unknown/absent events recorded rather than assumed;
- group message persistence and lifecycle events use account/group/message
  scoped idempotency and survive a reconnect overlap;
- unsupported content and unknown outcomes fail explicitly;
- group send policy, disable/rollback behavior, and operator metrics are
  documented; and
- a live result proves the smallest contract, not merely that a method exists
  in `zca-js`.

## Recommendation and acceptance boundary

Ranked choices:

1. **Recommended — Zalo Account-specific Full Group Inbox v1.** Add a separate
   group message event and storage adapter for text/image/file, quotes, mentions,
   self echoes, and exact provider IDs. Add group-shaped receipt/reaction/undo
   events with the convergence rules above. Keep group send to one text or one
   controlled attachment and retain explicit `sendEnabled`/admission. This is
   the smallest contract that can satisfy a real group Inbox without changing
   direct-message semantics.
2. **Follow-up — bounded enrichment.** Add member/profile snapshots, selected
   group update events, and bounded recent-history backfill after the live gates
   show the fields are present. Mark snapshots partial when the provider cannot
   enumerate the complete roster.
3. **Defer — broad provider parity.** Defer full administration, rich media and
   albums, edits, cross-provider abstractions, reaction automations, and
   unbounded history. Their SDK method existence is not sufficient evidence of
   stable provider behavior or product value.

Acceptance is therefore “provider-shaped group events are preserved and
converge safely under duplicate/reordered/reconnect delivery,” not “every
zca-js method is exposed.” The existing direct contract remains unchanged, and
the existing provider-scoped group resource policy remains the safety gate
until the Full Group Inbox has live evidence.

## Limitations

- This analysis inspected the pinned local SDK declarations/implementation, the
  ZaloCRM reference implementation, ChatbotX docs/contracts, and existing
  gateway/integration/worker code. It did not contact Zalo servers or run a
  live account.
- Provider limits, permissions, timing, and account/device differences remain
  unverified. ZaloCRM comments and sweep behavior are explicitly labeled as
  observations/policy, not guarantees.
- No implementation, migration, test, lint, install, generator, or production
  change was performed. The next implementation plan must choose the exact
  storage/API shape after the live gates above, rather than treating this report
  as approval to widen the public contract automatically.
