# ZaloCRM reference analysis for Zalo Account items 5–9

Date: 2026-11-20
Reference repository: `/Users/jacky/Documents/Github/ZaloCRM`
Target contracts: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/docs/zalo-account.md` and `plans/261119-1534-zalo-account-foundation/plan.md`

## Executive finding

ZaloCRM is a useful behavioral reference for the pinned `zca-js` 2.1.2
provider contract. It proves the SDK method names, listener event names, thread
types, message identifiers, attachment source/response shapes, profile fields,
group APIs, and native-label payloads. It also demonstrates the minimum useful
normalization needed for a CRM: self-listen echo suppression, old-message
backfill, CDN media mirroring, per-account UID identity, and a reverse label
index.

The application is not a safe architectural template for ChatbotX. ZaloCRM is a
single backend process with an in-memory singleton pool, direct Prisma writes,
Socket.IO as its transport, and an application-specific Contact/Friend/CRM-tag
model. Its retries, 30-second dedup window, rate limits, privacy modes, label
prefixes, and “sticky hold” behavior are product policy rather than zca-js
requirements. ChatbotX should reuse the provider adapter contract while keeping
the gateway isolated, workspace-scoped, Redis-fenced, epoch-guarded, and
business/repository mediated as required by the completed foundation.

No live Zalo account was used. The observations below come from static source,
the installed `zca-js` 2.1.2 package, repository docs, and Prisma schema.

## Sources and authority

| Source | Evidence | Authority/use |
|---|---|---|
| `backend/node_modules/zca-js/package.json:1-52` | Installed package is `zca-js` 2.1.2, unofficial, ESM/CJS export, Node >=18. | Strongest local evidence for the exact dependency in this checkout. |
| `backend/node_modules/zca-js/dist/**/*.d.ts` and `dist/apis/*.js` | Method signatures, payload types, event names, return values, and dispatch behavior. | Provider contract for this pinned version; unofficial and subject to change. |
| `backend/src/modules/zalo/zalo-pool.ts` | QR/reconnect/teardown/epoch/circuit-breaker implementation. | Operational evidence, but application-specific. |
| `backend/src/modules/zalo/zalo-listener-factory.ts` | Event subscriptions and normalization into CRM handlers. | Useful flow reference; tenant/DB behavior must be redesigned. |
| `backend/src/shared/zalo-operations.ts` | Command wrapper, retry/error policy, exact outbound calls. | Useful adapter shape; retry policy is not provider behavior. |
| `backend/src/modules/chat/message-handler.ts` and `chat-*.ts` | Persistence, identity, media, outbound idempotency. | Product-specific data and UX policy. |
| `backend/src/modules/zalo/zalo-labels-routes.ts` | Native-label full sync and write-back behavior. | Provider payload handling plus product-specific CRM mirroring. |
| `backend/prisma/schema.prisma:351-400,512-620,763-894,1380-1400,1882-2000` | ZaloAccount, Contact, Conversation, Message, ZaloLabel, Friend keys and fields. | Explains reference identity/persistence; not a ChatbotX schema recommendation. |
| `README.md`, `docs/architecture/README.md`, `backend/package.json` | Product scope, single-backend architecture, zca-js dependency, sync claims. | Context only; `docs/migration/contract-inventory.md` says current source is behavioral authority. |

The reference docs describe a Vue/Fastify/Prisma/Socket.IO application and
explicitly say that zca-js runs in a per-account pool/listener model
(`docs/architecture/README.md:18-21`). The ChatbotX foundation instead requires
`apps/zalo-account-gateway` to be the only zca-js owner, with `Connection` as
durable lifecycle source and Redis lease/fencing plus local epoch for runtime
ownership (`docs/zalo-account.md:19-28`).

## 1. Exact zca-js contract

### 1.1 QR login and credentials

`zca-js/dist/apis/loginQR.d.ts:3-65` defines the callback enum and data:

| Event | Numeric type | Data/action proven by SDK |
|---|---:|---|
| `QRCodeGenerated` | 0 | `{ code, image, options, token }`; actions `saveToFile`, `retry`, `abort`. |
| `QRCodeExpired` | 1 | `data: null`; actions `retry`, `abort`. |
| `QRCodeScanned` | 2 | `{ avatar, display_name }`; actions `retry`, `abort`. |
| `QRCodeDeclined` | 3 | `{ code }`; actions `retry`, `abort`. |
| `GotLoginInfo` | 4 | `{ cookie: SerializedCookie[], imei, userAgent }`; `actions: null`. |

`Zalo.loginQR(options?, callback?)` resolves an API object after login
(`loginQR.d.ts:61-65`). ZaloCRM’s `zalo-pool.ts:187-241` maps the numeric events,
emits a QR image to an account Socket.IO room, saves the credentials at event 4,
and then calls `api.getOwnId()` (`zalo-pool.ts:253-259`). The reference app
limits QR expiry retries to three and uses a fresh epoch/session after that
(`zalo-pool.ts:194-224`); this bound is good operational policy, not an SDK
requirement.

ChatbotX should translate these callbacks to the already accepted
`ConnectSession.nextAction = show_qr` contract. It must not put the raw cookie,
IMEI, user-agent, QR image, or decrypted auth in logs or public errors. The
foundation explicitly requires encrypted custom auth, identity verification with
`getOwnId`, and QR action clearing (`docs/zalo-account.md:30-59`).

### 1.2 Listener lifecycle and events

`zca-js/dist/apis/listen.d.ts:22-46,80-100` exposes these events and payloads:

| Event | SDK payload | ZaloCRM consumer |
|---|---|---|
| `connected` | no args | Log only (`zalo-listener-factory.ts:413-415`). |
| `disconnected` | `(code, reason)` | Early status/socket signal (`zalo-listener-factory.ts:609-614`). |
| `closed` | `(code, reason)` | Lifecycle owner calls reconnect/circuit-breaker (`zalo-listener-factory.ts:986-990`). |
| `error` | `unknown` | Log (`zalo-listener-factory.ts:992-994`). |
| `message` | `Message` (`UserMessage` or `GroupMessage`) | Normalize/persist (`zalo-listener-factory.ts:616-763`). |
| `old_messages` | `(Message[], ThreadType)` | Backfill (`zalo-listener-factory.ts:857-958`). |
| `typing` | `Typing` | Emit typing signal (`zalo-listener-factory.ts:431-453`). |
| `seen_messages` | `SeenMessage[]` | Mark/sweep outgoing rows (`zalo-listener-factory.ts:455-516`). |
| `delivered_messages` | `DeliveredMessage[]` | Mark delivered or merged delivered+seen (`zalo-listener-factory.ts:518-607`). |
| `reaction` / `old_reactions` | `Reaction` / `(Reaction[], isGroup)` | Persist live/backfill reactions (`zalo-listener-factory.ts:798-810`). |
| `undo` | `Undo` | Match `content.globalMsgId` or `content.cliMsgId`, mark deleted (`zalo-listener-factory.ts:765-796`). |
| `friend_event` | `FriendEvent` | Friend state machine (`zalo-listener-factory.ts:812-855`). |
| `group_event` | `GroupEvent` | Refresh group metadata on update (`zalo-listener-factory.ts:960-981`). |
| `upload_attachment` | `{ fileUrl, fileId }` | Mainly consumed internally by upload; SDK also emits it (`listen.d.ts:9-12,40`). |

The pinned implementation confirms the wire dispatch in
`zca-js/dist/apis/listen.js:98-143,175-261,265-355`: user messages are command
501, group messages command 521, controls command 601, reactions 610/611/612,
old messages 510/511, typing 602, read receipts 502/522. Consumers should rely
on named SDK events, not these numeric commands; the numeric mapping is useful
only when diagnosing a package upgrade.

`Listener.start({ retryOnClose })` throws if already started, resets on close,
emits `disconnected`, and, when retry is enabled and the close code is
retryable, schedules another `start`; otherwise it emits `closed`
(`listen.js:98-143`). `stop()` closes with code 1000 and resets
(`listen.js:363-367`). Close enums include `1000` manual, `1006` abnormal,
`3000` duplicate connection, and `3003` kicked connection
(`listen.d.ts:22-27`). A single account must have only one active WebSocket;
the SDK itself cannot provide distributed ownership or fencing.

### 1.3 Message identity and normalized payload

The SDK model uses `ThreadType.User = 0` and `ThreadType.Group = 1`
(`zca-js/dist/models/Enum.d.ts:1-4`). `Message.d.ts` defines message data with
server `msgId`, client `cliMsgId`, sender `uidFrom`, recipient `idTo`, timestamp
`ts`, `msgType`, `content`, optional `quote`, and group `mentions`. zca-js wraps
that as `{ type, data, threadId, isSelf }`.

For an inbound or self echo, the stable provider fields to preserve are:

- account identity (which connected Zalo account owns the listener);
- `type`/thread type and `threadId` (user UID or group ID);
- `data.msgId` (server/global message ID) and `data.cliMsgId` (client ID);
- `data.uidFrom`, `data.idTo`, `data.ts`, `data.msgType`, `data.content`, `data.quote`;
- `isSelf` and, for group messages, `mentions`.

ZaloCRM passes these fields through `IncomingMessage` with explicit
`threadType`, `msgId`, `cliMsgId`, `isSelf`, quote, album metadata, and profile
fields (`message-handler.ts:25-66`). ChatbotX should keep both IDs in its
normalized event even if a first version only needs the server ID; undo/delete
and quote operations require both in the SDK.

### 1.4 Outbound command methods and constraints

The core `sendMessage` contract is `sendMessage(message, threadId, type?)`
(`sendMessage.d.ts:66-97`). The return shape is always:

```ts
{
  message: { msgId: number } | null,
  attachment: Array<{ msgId: number }>
}
```

(`sendMessage.d.ts:2-8`). The SDK rejects a missing `message`, `threadId`, or a
payload with neither non-empty `msg` nor attachments
(`sendMessage.js:410-425`). A string is converted to `{ msg }`. `msg` must still
be present when sending attachments; ZaloCRM deliberately passes `{ msg: '' ,
attachments }` (`zalo-operations.ts:280-285`).

`MessageContent` supports `msg`, `styles`, urgency, quote, group mentions,
attachments, and TTL (`sendMessage.d.ts:66-95`). Group mentions are filtered to
valid positions and the SDK maps UID `-1` to an all-members mention; total
mention length cannot exceed message length (`sendMessage.js:121-142`). Quotes
need provider fields `content`, `msgType`, `propertyExt`, `uidFrom`, `msgId`,
`cliMsgId`, `ts`, and `ttl` (`sendMessage.d.ts:9-18`). Webchat and group-poll
quote variants are rejected by the SDK (`sendMessage.js:165-197`).

Other exact methods observed in the installed package:

| Capability | SDK method and input shape | Important constraint |
|---|---|---|
| Sticker | `sendSticker({ id, cateId, type }, threadId, type)` (`sendSticker.d.ts:1-9`). | Provider IDs, not arbitrary image files. |
| Link | `sendLink({ msg?, link, ttl? }, threadId, type)` (`sendLink.d.ts:1-9`). | URL is provider-parsed. |
| Card | `sendCard({ userId, phoneNumber?, ttl? }, threadId, type)` (`sendCard.d.ts:1-9`). | User card, not a CRM contact object. |
| Voice | `sendVoice({ voiceUrl, ttl? }, threadId, type)` (`sendVoice.d.ts:1-11`). | SDK performs `HEAD` on the URL (`sendVoice.js:18-30`); a local path is not the declared input. |
| Video | `sendVideo({ videoUrl, thumbnailUrl, duration?, width?, height?, msg?, ttl? }, threadId, type)` (`sendVideo.d.ts:1-34`). | SDK performs `HEAD` on the URL (`sendVideo.js:29-40`); local-file support must be an adapter upload path. |
| Upload | `uploadAttachment(source(s), threadId, type)` (`uploadAttachment.d.ts:1-50`). | Source is a local filepath or `{ data: Buffer, filename, metadata: { totalSize, width?, height? } }` (`Attachment.d.ts:1-8`). |
| Forward | `forwardMessage({ message, ttl?, reference? }, threadIds, type)` (`forwardMessage.d.ts:1-23`). | ZaloCRM reports code 112 if the source reference `{ id, ts, logSrcType, fwLvl }` is omitted (`zalo-operations.ts:352-371`). |
| Reaction | `addReaction(icon, { data: { msgId, cliMsgId }, threadId, type })` (`addReaction.d.ts:1-17`). | Destination is nested; positional IDs are wrong. |
| Delete | `deleteMessage({ data: { cliMsgId, msgId, uidFrom }, threadId, type }, onlyMe?)` (`deleteMessage.d.ts:1-14`). | Requires the sender UID and both IDs. |
| Recall | `undo({ msgId, cliMsgId }, threadId, type)` (`undo.d.ts:1-9`). | ZaloCRM observes code 112 for very recent messages and retries. |

`sendMessage` has a significant attachment behavior: if a caption cannot be
embedded with a single image, or if a caption+quote accompanies media, it sends
text first and media separately (`sendMessage.js:430-449`). Multiple non-GIF
attachments become an album with `groupLayoutId`, `idInGroup`, and
`totalItemInGroup` (`sendMessage.js:245-282`). Images, videos, and generic files
are uploaded differently and return different upload metadata
(`uploadAttachment.d.ts:2-37`). The SDK uses its configured max-file count and
size (`sendMessage.js:72-77,424-425`); application upload limits must not be
assumed to equal Zalo’s server limits.

## 2. Reference flows in ZaloCRM

### 2.1 Gateway/SDK command and event handling (item 5)

ZaloCRM has no separate gateway process. `zalo-pool.ts:78-96` holds a process
singleton `Map<accountId, ZaloInstance>`, and `createRequire` loads the SDK
because its ESM declarations were considered unreliable (`zalo-pool.ts:24-34`).
All commands are intended to go through `zalo-operations.ts:1-10`:

1. Resolve the live API from the pool.
2. Check an application rate-limit category.
3. Invoke the zca-js method.
4. On a session-expiry string, reconnect and retry once with the fresh API.
5. On transient socket/fetch errors, retry up to three attempts with 400/800 ms
   delays (`zalo-operations.ts:163-269`).
6. Wrap unknown failures in `ZaloOpError` and optionally emit Socket.IO.

The wrapper gives ChatbotX a useful shape—one typed command adapter around all
SDK calls—but its rate-limit categories, Socket.IO emission, string matching for
session errors, and retry budgets are application-specific. A ChatbotX command
consumer should include workspace/account/session/epoch/fence context and
return a stable provider-neutral result/error envelope. It should serialize
commands that mutate the same account when the provider operation is not safely
concurrent (especially label replacement and listener-affecting commands).

ZaloCRM attaches every named event in `attachZaloListener` and starts the SDK
with `retryOnClose: true` (`zalo-listener-factory.ts:385-411,986-997`). It also
wraps `listener.emit` to log unknown events (`zalo-listener-factory.ts:417-429`),
which is useful during a pinned SDK compatibility audit but should not log raw
payloads in production. The callback path is asynchronous and can outlive the
current account instance, so ChatbotX’s existing epoch/fence guard must happen
before publishing or invoking trusted session transitions.

### 2.2 Connection and listener lifecycle (item 6)

The reference lifecycle is:

```text
loginQR/reconnect
  -> teardownExisting(old listener + message sync)
  -> increment epoch; install connecting/qr_pending instance
  -> SDK login/loginQR
  -> getOwnId + profile lookup
  -> persist status/UID
  -> attachZaloListener + listener.start({ retryOnClose: true })
  -> backfill/sync work
  -> closed -> mark disconnected -> circuit breaker or delayed reconnect
```

Evidence:

- `teardownExisting` stops the old listener before replacement because SDK
  retry-on-close otherwise allows duplicate sockets and a kick/reconnect flap
  (`zalo-pool.ts:137-158`).
- QR login installs a fresh epoch before waiting for the SDK and drops all
  callbacks from a superseded epoch (`zalo-pool.ts:187-207`); it repeats the
  guard after `loginQR` resolves and stops the stale API if necessary
  (`zalo-pool.ts:243-250`).
- Reconnect has an in-flight account guard, skips archived/ghost/manual accounts,
  tears down before creating a new SDK instance, and verifies the reconnected
  `getOwnId()` equals the stored UID (`zalo-pool.ts:327-417`).
- The listener’s `closed` callback ignores a stale epoch, marks the current
  instance disconnected, stops message sync, and tracks disconnects. Five closes
  within five minutes trip a QR-required circuit breaker; otherwise reconnect is
  scheduled after 30 seconds (`zalo-pool.ts:475-539`).
- A second broad catch schedules another auto-reconnect after two minutes
  (`zalo-pool.ts:729-766`). Manual `disconnect` stops the listener and removes
  the map entry (`zalo-pool.ts:769-779`).

This is strong evidence for the foundation’s accepted teardown-before-replace,
identity mismatch, stale-callback, bounded retry, and manual-stop invariants. It
does not replace ChatbotX’s distributed Redis lease/fencing: the ZaloCRM pool is
in-process and has no protection when two replicas own the same account. The
reference also has many timers and product side effects (sticky-hold worker
notifications at `zalo-pool.ts:840-957`) that should not be copied into the
gateway.

### 2.3 Inbound messages, outbound messages, and attachments (item 7)

Inbound path (`zalo-listener-factory.ts:616-763`):

1. Determine group versus user from `message.type === 1`; use `data.uidFrom` as
   sender and `threadId` as the user/group thread.
2. For a self DM, resolve the peer using `threadId`; for an inbound DM, resolve
   `uidFrom` using `getUserInfo`.
3. For a group, call `getGroupInfo(threadId)` to obtain name/avatar/member count.
4. Preserve raw string or JSON content, map `msgType`/content shape with
   `detectContentType`, extract album metadata and mentions, and pass both
   provider IDs to `handleIncomingMessage`.
5. Persist, scope/redact realtime output by org/privacy policy, and send push
   only for inbound messages.

`detectContentType` is deliberately defensive: it maps image/sticker/video/voice/
GIF/link/location/file, and special call, QR, bank-transfer, reminder, poll,
note, and forwarded content; it checks action/shape before broad `msgType`
keywords (`zalo-message-helpers.ts:17-119`). This classifier is a useful example
but should be isolated and tested against captured provider fixtures because
unknown zca-js content is not a stable public schema.

Inbound media handling is application-specific but operationally valuable:
`message-handler.ts:93-203,205-265` finds CDN URLs in common fields and nested
`params.rawUrl`/`hd`, fetches with a 20-second timeout, retries an empty response
once after 1.5 seconds, compresses images, mirrors to object storage, and keeps
the original URL if mirroring fails. CDN URLs may expire; ChatbotX should use a
provider-neutral attachment record and durable object storage, with explicit
limits and SSRF/host validation. ZaloCRM logs failed URLs in warnings
(`message-handler.ts:210-239`); ChatbotX should avoid exposing or logging raw
provider URLs if its security policy treats them as sensitive.

Outbound text route (`chat-routes.ts:1489-1839`):

- Input includes content, optional styles, group mentions, reply message ID,
  and `echoId`/`clientMessageId` (`:1493-1512`).
- It derives SDK `threadType` from the persisted conversation (`:1649-1652`),
  builds a provider quote from the stored message, and sends
  `instance.api.sendMessage(sendPayload, threadId, threadType)` (`:1653-1688`).
- It extracts `sendResult.message.msgId` for text or
  `sendResult.attachment[0].msgId` for media (`:1689-1696`), persists the row,
  and emits a scoped result.
- It recognizes Zalo business rejection (for example stranger-blocked) and
  stores a failed row with reason/code, while true system errors remain errors
  (`:1697-1711,1745-1755,1822-1837`).

The outbound route’s durable idempotency is stronger than the self-echo
heuristic: it looks up `(conversationId, clientEchoId)` before provider send and
handles a concurrent unique violation by returning the winner row
(`chat-routes.ts:1632-1647,1758-1775`; schema `:873-884`). ChatbotX should use a
durable command/idempotency key before sending whenever the caller may retry
after losing a response. A provider `msgId` only exists after send and cannot
prevent duplicate provider sends by itself.

Attachment route (`chat-attachment-routes.ts:65-312`) accepts multipart files,
limits MIME/size, writes temporary local paths, mirrors to MinIO, sends images as
one `sendMessage({ msg: caption, attachments: paths })`, sends videos through a
custom local-file `sendNativeVideo` with a generic-file fallback, and sends other
files one at a time through `zaloOps.sendFile` (`:106-175,193-279`). It cleans
temporary paths in `finally` (`:301-309`). The route demonstrates the important
provider constraint that zca-js upload attachments are local paths or Buffer
objects, not arbitrary remote URLs. It also contains a compatibility risk worth
not copying: the route reads `sendResult.msgId`/`sendResult.data.msgId`
(`:176-177,215-216,232-240,256-267`), while the pinned SDK’s declared
`sendMessage` result nests IDs under `message` or `attachment`
(`sendMessage.d.ts:2-8`). ChatbotX should centralize return-shape extraction in
one adapter and test each command variant.

### 2.4 Conversation identity, personal/group threads, and group controls (item 8)

The provider’s identity distinction is simple and should be retained:

- User thread: `ThreadType.User = 0`, `threadId` is the peer UID.
- Group thread: `ThreadType.Group = 1`, `threadId` is the group ID.
- Self DM messages must resolve the peer from `threadId`/`idTo`, not treat the
  account’s own UID as the contact.
- Old DM events may omit top-level `threadId`; ZaloCRM derives it from `idTo`
  for self or `uidFrom` for inbound (`zalo-listener-factory.ts:857-872`).

ZaloCRM’s persistence identity is per account plus external thread ID:
`Conversation` has `@@unique([zaloAccountId, externalThreadId])` and stores
`threadType` and group metadata (`schema.prisma:763-808`). `Friend` has
`@@unique([zaloAccountId, zaloUidInNick])` (`schema.prisma:1882-2000`). The
application documentation calls this “one person × one nick,” not one person
globally (`docs/architecture/README.md:36-44`). The global `globalId` and
username are used for cross-account contact dedup, but the per-account UID
remains the conversation/friend key.

`message-handler.ts:806-975` models groups as a Contact-like row keyed by
group UID with `metadata.isGroup`, while user contacts use this lookup order:
Friend `(account, uid)` first, then org `globalId`, username, and per-account
UID, then race-safe create. This is a proven reference identity strategy, not a
provider requirement. ChatbotX should decide whether groups are a separate
conversation participant type rather than forcing them into a customer contact
model; either way, keep `(workspace, account, threadType, providerThreadId)` in
the normalized key to prevent accidental user/group collisions.

One subtle reference risk is that ZaloCRM’s `Conversation` database unique key
does not include `threadType` (`schema.prisma:797`). The provider normally uses
different ID domains, but a provider/API change or malformed data could collide.
ChatbotX should include thread type in its channel conversation identity or
explicitly prove the provider namespaces are disjoint.

Group discovery and controls:

- `getAllGroups()` returns an object with `gridVerMap`/possibly
  `gridInfoMap`, not a simple array. ZaloCRM obtains IDs from `gridVerMap` and
  calls `getGroupInfo` in chunks of 50 for names/counts
  (`group-routes.ts:17-57`).
- `getGroupInfo(groupId|string[])` returns `gridInfoMap[groupId]` with group name,
  avatar, total member count, member/admin IDs, `memVerList`, and a
  `GroupSetting` (`getGroupInfo.d.ts:1-16`, `Group.d.ts:96-125`).
- Member profiles come from `getGroupMembersInfo(memberId|string[])`, whose
  profiles include ID, display name, Zalo name, avatar, and global ID
  (`getGroupMembersInfo.d.ts:1-17`). ZaloCRM strips `_version` suffixes from
  `memVerList` and batches profiles (`group-routes.ts:69-88`).
- Provider group operations include `createGroup`, `changeGroupName`,
  `changeGroupAvatar`, `updateGroupSettings`, `addUserToGroup`,
  `removeUserFromGroup`, deputy/admin operations, owner transfer, block/unblock,
  pending-member review, links, leave, and disperse. ZaloCRM exposes these in
  `group-routes.ts:91-180` and `group-moderation-routes.ts:15-113`.
- `updateGroupSettings` accepts provider flags such as `blockName`, `joinAppr`,
  `lockCreatePost`, `lockCreatePoll`, `lockSendMsg`, and `lockViewMember`
  (`updateGroupSettings.d.ts:1-40`). These flags are provider controls, not a
  substitute for ChatbotX’s own authorization/policy layer. Zalo’s permission
  errors (including common 166/165 cases in the provider docs/types) should be
  normalized to typed “provider denied” results rather than treated as an
  application admin grant.

### 2.5 Provider labels/tags and profile mapping (item 9)

Native labels are a whole-document API. `getLabels()` returns
`{ labelData, version, lastUpdateTime }`; each `LabelData` has numeric `id`,
`text`, `textKey`, `conversations: string[]`, `color`, `offset`, `emoji`, and
`createTime` (`getLabels.d.ts:1-7`, `Label.d.ts:1-10`). `updateLabels` accepts
the entire `{ labelData, version }` and returns the updated structure and
version (`updateLabels.d.ts:1-14`). This is not a per-contact patch endpoint.

ZaloCRM’s sync (`zalo-labels-routes.ts:42-170`) stores a mirror in
`ZaloLabel` keyed by `(zaloAccountId, zaloLabelId)`, reverse-indexes each
conversation/UID, and recomputes `Friend.zaloLabels`. Full sync deletes labels
missing from the provider; delta sync updates affected Friend rows only. It
also mirrors definitions into CRM tags and strips/reapplies a provider-specific
`🔵 ` prefix (`zalo-labels-routes.ts:172-220`). The DB mirror has the same
account+label uniqueness (`schema.prisma:1376-1400`).

Assigning a label reads the full current document, removes a thread UID from
all labels, adds it to one target, and calls `updateLabels` (`zalo-labels-routes.ts:668-737`;
friend route `:745-803`). The code deliberately seeds its local sync from the
write response because `getLabels()` can lag 1–3 seconds after a write
(`zalo-labels-routes.ts:721-735`). It uses a 5-second passive-sync cooldown and
30-second user-action grace (`:856-893`).

This exposes the main label race: two concurrent full-document writes can lose
one another. ZaloCRM’s deferred queue documents the issue and suggests a serial
per-account queue, but the worker defaults to concurrency 4 and the queue is not
wired (`zalo-label-queue.ts:1-24,66-105`). ChatbotX should make label mutations
per-account serialized gateway commands with version/conflict handling; it
should not copy the deferred queue as if it were a proven fix.

Profile mapping uses `getUserInfo(uid|string[])`, which returns
`changed_profiles` keyed by UID and includes `userId`, username, display name,
Zalo name, avatar, cover, gender, date/birth strings, phone number, status,
`globalId`, and activity fields (`getUserInfo.d.ts:1-8`; `User.d.ts:3-34`).
ZaloCRM caches these values for five minutes and tolerates the provider’s
`uid`/`uid_0` key variation (`zalo-listener-factory.ts:249-306`). It uses
`globalId` and username for cross-account contact matching, but stores
per-account display/avatar/UID on `Friend` (`message-handler.ts:846-974`,
`schema.prisma:1896-1915`). This split is a good model for ChatbotX: provider
identity/profile belongs to the account-scoped participant/connection, while
workspace CRM identity can be linked separately and must not overwrite
workspace-owned fields without an explicit merge policy.

Friend events are not the same as message events. The SDK provides
`friend_event`; ZaloCRM maps ADD/REMOVE/REQUEST/REJECT/UNDO/BLOCK/UNBLOCK to a
Friend state machine (`friend-event-handler.ts:1-39,345-434`). This may be
useful if item 9 includes contact/friend lifecycle, but the state names and
CRM counters are application policy.

## 3. Failure, retry, deduplication, and safety risks

### Provider/runtime risks proven by the source

1. **Duplicate connection eviction.** The SDK recognizes another connection and
   closes with duplicate-connection behavior (`listen.js:349-355`). Starting
   `retryOnClose` on two live instances can create a kick/reconnect flap. Always
   stop the old listener before replacement and reject stale callbacks.
2. **SDK retry is not distributed.** `retryOnClose` is local to one Listener;
   it does not know Redis leases, workspace ownership, or fencing. ChatbotX must
   validate lease/fence/epoch before publishing each event and before executing
   reconnect/command side effects.
3. **Close signals have two phases.** `disconnected` fires before the SDK decides
   whether to retry, while `closed` means the retry path ended or was not used
   (`listen.js:123-139`). ZaloCRM only reconnects on `closed`; ChatbotX should
   avoid double scheduling from both.
4. **Messages can arrive as echoes or backfills.** `selfListen: true` is needed
   for CRM-send acknowledgement, but it makes every outbound message appear as
   a listener event. `old_messages` after reconnect can overlap already persisted
   rows. Persist provider IDs with a unique constraint and make backfill
   idempotent.
5. **Album events are multiple messages.** One outbound album may result in N
   provider message IDs with shared layout metadata (`sendMessage.js:245-282`).
   Treat each item as a durable message/attachment while retaining album key,
   index, and total.
6. **Attachment completion is asynchronous.** Video/file upload waits for the
   SDK’s `file_done` control and `upload_attachment` callback
   (`listen.js:213-227`); connection loss during this wait can strand an upload.
   Gateway commands need timeout/cancellation and a retry policy that does not
   blindly re-send a partially completed upload.
7. **Provider errors are not stable application errors.** ZaloCRM relies on
   `ZaloApiError` names and text/code patterns (`zalo-operations.ts:91-107,
   246-269`, `chat-routes.ts:1697-1710`). Keep raw provider diagnostics private;
   expose typed categories such as not connected, reauthorization required,
   provider denied, invalid payload, rate limited, and transient transport.
8. **URLs and files have different contracts.** `sendVideo`/`sendVoice` expect
   URLs and issue `HEAD`; `sendMessage` attachment upload expects a local path or
   Buffer metadata. A generic “media URL” command can silently fail or send the
   wrong provider message unless the adapter selects the correct method.

### ZaloCRM-specific behavior that should not be mistaken for provider truth

- 30-second self-echo matching by content or content type is a heuristic
  (`message-handler.ts:298-373`). It can mis-associate two identical messages;
  the durable `echoId`/unique key should be primary in ChatbotX.
- The app claims a 200-message/day anti-block limit in README (`README.md:98-109`)
  and has many rate-limit categories. Zalo’s actual current limits were not
  verified here; treat those as operator policy/experience, not SDK guarantees.
- The five disconnects in five minutes breaker, 30-second reconnect, two-minute
  fallback timer, archived/manual account rules, and sticky-hold notifications
  are ZaloCRM product choices (`zalo-pool.ts:327-365,518-539,729-766,840-957`).
- Direct Socket.IO org-room emission, privacy “main/sub” modes, Prisma models,
  Telegram bridge events, CRM aggregates, and mobile push are application
  concerns. ChatbotX must route through its own public API/business/service and
  workspace-scoped event contract.
- ZaloCRM has a rare fallback bare `io.emit` when org resolution fails
  (`zalo-listener-factory.ts:405-411`), and logs serialized SDK payload snippets
  (`:417-429`). Both are unsafe defaults for ChatbotX’s strict tenant/secret
  invariants and should be rejected by design.
- The reference attachment route’s nested-ID extraction mismatch described above
  (`chat-attachment-routes.ts:176-177` versus `sendMessage.d.ts:2-8`) shows why
  every adapter command needs contract tests against the pinned package.

## 4. What ChatbotX should reuse versus redesign

| Area | Reuse from ZaloCRM / zca-js | Intentionally redesign for ChatbotX |
|---|---|---|
| SDK dependency | Pin `zca-js` 2.1.2 as accepted by the foundation; isolate imports to `apps/zalo-account-gateway`. | No direct zca-js imports in builder/router/worker; add a compatibility fixture suite before upgrades. |
| QR/device auth | Map SDK QR events 0–4, persist cookie/IMEI/user-agent only after validation, call `getOwnId`, reject UID mismatch. | Use `ConnectSession`, encrypted auth, workspace-bound AAD, bounded QR action/TTL, and no secret/QR logs. |
| Commands | Named method/payload map: `sendMessage`, upload, group, labels, profile, reactions, undo, receipts. Preserve both `msgId` and `cliMsgId`. | Gateway command envelope with workspace/account/session/epoch/fence; idempotency key and per-account ordering for mutating operations; typed provider-neutral errors. |
| Events | Named SDK events and payload normalization; `ThreadType` 0/1; `message`, `old_messages`, `friend_event`, `group_event`, receipts, reaction, undo. | Publish only after lease/fence/epoch validation; persist event cursor/dedup where needed; never broadcast unscoped events; separate early `disconnected` from terminal `closed`. |
| Lifecycle | Teardown-before-replace, one listener/account, identity check, stale callback guard, bounded reconnect/circuit-breaker concepts. | Distributed Redis lease/fencing is authoritative; no in-memory pool as source of ownership; manual stop state from `Connection`; graceful shutdown and health/readiness integrated with gateway. |
| Inbound messages | Preserve provider IDs, thread type/id, raw content, quote, mentions, album metadata; classify known content and keep unknown raw payload privately. | Normalize into ChatbotX message contracts and business service; tenant/workspace scoping; durable provider ID uniqueness and safe backfill; avoid heuristic-only 30-second dedup. |
| Outbound text/media | Use exact nested return shape; local paths/Buffer for `sendMessage` attachments; URL+HEAD contract for voice/video; handle album N-message result. | Durable outbox/idempotency before send; avoid provider retry after unknown outcome unless command semantics prove safe; object storage mirror with size/MIME/host controls; one adapter extraction function. |
| Conversation identity | Per-account provider UID/group ID, user vs group thread, self DM peer resolution, `globalId`/username enrichment. | Include workspace + account + thread type + provider thread ID in canonical key; separate group participant from CRM contact if product semantics require; do not inherit ZaloCRM’s unique key omission. |
| Groups | `getAllGroups` object shape, `getGroupInfo`, `getGroupMembersInfo`, settings/membership APIs, group events and mentions. | Authorize every group operation via ChatbotX workspace access and explicit group policy; model provider denial separately from local permission; avoid copying ZaloCRM’s admin-only route assumptions. |
| Labels/tags | Whole-document `{labelData,version}` and response seed; mirror label fields and reverse-index assigned thread IDs. | Serialize whole-document writes per account; version/conflict handling; durable sync status; keep native labels distinct from ChatbotX tags unless an explicit bridge contract exists; no hard-coded `🔵` prefix. |
| Contacts/profiles | Five-minute cache, `globalId`/username plus per-account UID, profile field mapping and `uid_0` fallback. | Business/repository contact resolution, fill-only provider profile updates, workspace privacy/merge rules, no direct gateway DB writes; do not assume phone/demographics are always present. |
| Errors/retry | Recognize SDK close codes and provider errors; bounded transport retry for safe operations; code-112 recall delay as an observed behavior. | Per-command retry classification with idempotency; no string-only session detection as the sole source; avoid retrying a send after ambiguous network outcome; metrics/redacted diagnostics. |

## 5. Checklist-oriented recommendations for items 5–9

### Item 5 — Gateway command/event transport and SDK adapter

Implement a small gateway-owned adapter around the exact zca-js methods and
named listener events above. Define versioned command/event envelopes that carry
workspace ID, Zalo account/connection ID, runtime reference, epoch, and fencing
token. Reject stale/foreign envelopes before SDK invocation or event publish.
Do not expose raw SDK objects beyond the gateway; normalize message, profile,
group, label, and error data at the boundary.

### Item 6 — Connection/listener lifecycle

Reuse the reference’s teardown-before-replace and identity verification, but
make Redis lease/fencing the owner across replicas. A single account must have
one active listener; manual disconnect must not be revived by SDK retry or a
delayed reconnect timer. Test stale `closed`, QR, message, and upload callbacks
after a replacement instance.

### Item 7 — Messages and attachments

Start with text, reply/quote, image/file upload, and receive/backfill. Preserve
`msgId` and `cliMsgId`, use a durable send idempotency key, and normalize nested
`sendMessage` return IDs. Treat media upload completion and CDN mirroring as
separate steps with timeouts, size/host checks, and a durable fallback URL or
failed-media state. Add fixtures for user/group, self/inbound, unknown content,
albums, and `file_done`.

### Item 8 — Conversations and groups

Canonicalize user and group identities with an explicit thread-type discriminator
and account scope. Resolve self DMs to the peer UID. Add only the group actions
that the ChatbotX product authorizes; use provider `GroupSetting` flags as
provider operations, not as the authorization model. Persist group membership
and metadata changes idempotently from `group_event` and read APIs.

### Item 9 — Labels/tags and contacts/profiles

Implement native-label read/write as an account-serialized full-document
operation with version and response-seed handling. Store provider labels
separately from ChatbotX tags. Cache `getUserInfo`, match global identity only
where the provider proves it stable, and retain per-account UID/name/avatar.
Route contact merges and profile writes through ChatbotX business services;
provider metadata must not overwrite user-entered CRM fields without an explicit
policy.

## 6. Open risks and limits

- The provider is unofficial; zca-js behavior, close codes, payload fields,
  server limits, and account restrictions can change without notice. This is
  explicitly acknowledged by ChatbotX (`docs/zalo-account.md:6-9`) and zca-js’s
  own README warning.
- This report did not execute zca-js against a live account and did not validate
  current Zalo server responses, actual rate limits, regional behavior, or
  permissions. The package implementation and types are the evidence for the
  pinned version only.
- The report does not recommend copying ZaloCRM’s Prisma schema, Socket.IO
  events, privacy model, CRM tags, Telegram bridge, sticky-hold workflow, or
  timers. Those are useful examples of application concerns, not accepted
  ChatbotX contracts.
- `old_messages`/history pagination and upload callback behavior need fixture or
  live-account tests in the gateway because static types do not prove every
  payload variant emitted by Zalo.

## Bottom line

Use ZaloCRM as a provider-behavior oracle for `zca-js` 2.1.2, especially the
named method/event signatures, dual message IDs, thread type, attachment
formats, group response shapes, profile identifiers, and whole-document label
updates. Use the completed ChatbotX foundation as the architecture oracle:
isolated gateway, encrypted auth, `Connection` lifecycle, Redis lease/fence,
epoch checks, workspace-safe events, public API first, and business/repository
boundaries. The two sources complement each other; treating the reference app’s
single-process policies as provider requirements would reintroduce the exact
multi-tenant and stale-runtime risks the foundation was designed to avoid.
