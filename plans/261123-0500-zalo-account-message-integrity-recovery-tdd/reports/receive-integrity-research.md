# Zalo Account receive-integrity research (TDD plan input)

Date: 2026-11-23 (Asia/Ho_Chi_Minh)

Scope is only `zaloAccount` receive, own echoes, durable message identity, schema
compatibility, unsupported-message observability, and the existing Inbox/public
read path. No code or tests were changed. This report does not propose media
archiving, history backfill, stickers, or a new event framework.

## Ranked findings

1. **Unsupported payloads are silently lost (highest P0 gap).** `normalizeProviderMessage`
   returns only `{ kind: "unsupported", reason }`, with no identity or safe
   metadata (`apps/zalo-account-gateway/src/runtime/provider-message.ts:31-39,
   212-244`). The client forwards the reason to `onUnsupported`, but the runtime
   handler is a no-op (`apps/zalo-account-gateway/src/runtime/zca-client.ts:78-90;
   apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:450-474`). No
   transport event, Inbox row, metric, placeholder, or public-read artifact is
   produced. This directly leaves checklist P0.4 items 87-89 incomplete
   (`docs/zalo-account-checklist.md:79-92`).

2. **One send can produce many provider IDs, but reconciliation only adopts the
   first ID.** The gateway returns the message ID plus every attachment ID
   (`apps/zalo-account-gateway/src/runtime/zca-client.ts:187-205`). The worker
   calls `updateMessageSourceId` with `result.messageIds[0]` only
   (`apps/worker/src/chat/handlers/send-message.ts:1379-1403`). The repository
   reconciliation/removal query is consequently scoped to that one source ID
   (`packages/database/src/sharding/message/repository/sharded-message-repository.ts:886-981`).
   Echoes for additional IDs can remain as duplicate outgoing rows. The existing
   source-ID reconciliation is otherwise strong and should be extended, not
   replaced.

3. **Echo-before-send-result is only best-effort.** Every canonical send creates
   its local row before provider dispatch (`packages/business/src/message/create-outgoing.ts:679-747`),
   and later source-ID reconciliation can remove matching echo rows. However the
   send worker logs and swallows reconciliation failure (`apps/worker/src/chat/handlers/send-message.ts:1393-1415`),
   while the fallback matches only recent text or a media type signature
   (`apps/worker/src/integration/handlers/received-message.ts:1163-1227,
   1230-1250`). A fast attachment/multi-ID echo or a failed reconciliation can
   therefore remain visible. The integration pipeline correctly avoids automation
   for an own echo (`apps/worker/src/integration/handlers/incoming-message.ts:20-24,
   78-106`), but it does not guarantee exactly one persisted row.

4. **Identity is semantically correct for normal direct traffic, but not retained
   completely and `isSelf` is trusted from the provider payload.** The direct
   adapter correctly chooses `threadId` as the peer for an own echo and
   `senderId` for inbound traffic, then rejects the connected UID
   (`integrations/zalo-account/src/message.ts:130-138`). The normalized message
   derives `isSelf` from the unverified provider flag
   (`apps/zalo-account-gateway/src/runtime/provider-message.ts:246-265`). The
   stored `zaloAccount` attributes retain provider/client ID, thread, sender,
   type, timestamp, and quote, but omit `recipientId` and `isSelf`
   (`integrations/zalo-account/src/message.ts:158-167`). This prevents later
   diagnosis/reconciliation of a contradictory classification. Group persistence
   has a durable identity/tombstone/pending-recovery design and must remain the
   owner of group rows (`packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:119-165,
   238-281`; `packages/business/src/zalo-account/group-inbox.service.ts:36-99`).

5. **There is no message schema version, and all message/transport payloads are
   strict.** Direct/group schemas have no `schemaVersion`
   (`packages/sdk/src/lib/zalo-account.ts:228-301`); the only existing `version`
   is the transport envelope literal `1` (`packages/sdk/src/lib/zalo-account.ts:700-718,
   750-872`). Existing DB/UI readers parse the group payload strictly and return
   `null` on any mismatch (`apps/builder/src/features/zalo-accounts/lib/group-content.ts:33-45`).
   A required new field would break old rows/events; an unknown future payload
   currently falls into the silent unsupported path. The smallest compatible
   contract is: emit normalized `schemaVersion: 1`, read absent as legacy v1,
   and route an explicitly unknown higher version to a safe placeholder rather
   than throwing or dropping it. Keep transport envelope `version` separate.

6. **Queue dedupe preserves identity but not event variants/order.** Gateway
   envelopes have a random `eventId` (`apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts:176-205,
   228-265`), but the worker job ID hashes account/thread/provider ID and drops
   the event ID (`apps/worker/src/events/zalo-account/handler.ts:164-188`). A
   duplicate provider delivery with corrected `isSelf`/metadata is therefore
   suppressed before persistence. Direct/group message jobs use the queue default
   of two attempts with exponential 5s backoff (`packages/worker-config/src/lib/connection.ts:103-109`);
   thread events explicitly use five attempts/1s exponential backoff
   (`apps/worker/src/events/zalo-account/handler.ts:109-136`). Persistence itself
   is source-ID idempotent (`packages/database/src/sharding/message/repository/sharded-message-repository.ts:1522-1595`),
   but no provider-order gate exists. Generic receive defaults `createdAt` to
   ingestion time (`apps/worker/src/integration/handlers/received-message.ts:1320-1342`),
   while the group repository seeds identity/message time with `new Date()`
   (`packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:127-139`).
   Thus late events cannot duplicate when source IDs are present, but timeline
   ordering is arrival order and no last-activity regression test exists for
   Zalo Account.

7. **UI/public reads can carry a persisted placeholder but cannot render one
   today.** The generic public `messages.list/get` routes return the full message
   resource (`apps/builder/src/features/messages/api/public.ts:149-213`; resource
   schema `apps/builder/src/features/messages/schema/resource.ts:10-57`). The
   Inbox only has a Zalo-specific group parser/status/context, and message text or
   attachments are the only normal bubble content (`apps/builder/src/features/messages/components/message-item.tsx:198-201,
   337-385`). A placeholder with no text/attachments is visually empty; there is
   no unsupported-content renderer or localized label. Existing i18n already
   provides `useTranslations("zaloAccount")` (`message-item.tsx:168-171`), so a
   small Zalo-only helper/component and translation key are sufficient.

## Smallest bounded fix shape for the plan

1. **Normalize/contract.** Add a versioned Zalo direct/group normalized shape,
   with a read parser that defaults missing `schemaVersion` to `1`. Preserve the
   current envelope `version: 1`; do not make a new required field in old stored
   JSON. Parse unknown versions before the strict known-version schema and route
   them to the unsupported path.

2. **Identity/reconciliation.** Preserve `providerMessageId`, `clientMessageId`,
   `threadId`, `threadType`, `senderId`, `recipientId`, `timestampMs`, `msgType`,
   and `isSelf` in the Zalo content attributes. At the gateway boundary, compare
   sender/recipient with the already verified account UID where available; a
   contradiction is a sanitized diagnostic/unsupported result, not a guessed
   peer. Keep peer selection (`self -> threadId`, inbound -> senderId) and the
   existing `za:<account>:<thread>:<providerId>` source identity. Reconciliation
   must claim all provider IDs returned by one canonical attempt, including
   attachment IDs, under one command/attempt identity; do not delete/replay a
   provider send.

3. **Dedupe/order/retry.** Use transport `eventId` in the worker ingress job ID
   (same provider identity remains the DB source ID), so a distinct later event
   can reconcile metadata while a stream redelivery of the same event remains
   deduplicated. Add a Zalo-only admission/reconciliation test for duplicate,
   out-of-order, late, undo-before-message, and echo-before-result cases. Do not
   reorder other channels. If chronological display is required, choose one
   explicit Zalo-only rule (validated provider timestamp as message ordering, or
   a separate order key); do not silently change the shared `createdAt` contract.

4. **Unsupported placeholder + diagnostics.** For a valid thread/message
   identity but unsupported content/version, persist one stable-source Zalo
   placeholder with no raw body, raw JSON, provider URL, or attachment download;
   skip automation and emit one bounded structured diagnostic/metric. For missing
   identity, emit the diagnostic and ACK/drop because there is no safe contact or
   source key. For DB/queue failure, throw so the existing bounded job retry can
   rerun idempotently; provider writes remain non-replayable. The gateway's
   current `eventQueue` catches and discards publish errors
   (`apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:716-723`), so
   the plan must either make this path observable/retryable or explicitly record a
   durable diagnostic before acknowledging the provider callback.

5. **Read/render.** Add a Zalo-only parser for legacy/v1/unsupported attributes;
   render a localized “unsupported Zalo message” bubble with only allowlisted
   type/reason metadata. Keep generic public `messages.list/get` as the read path,
   but ensure the returned content attributes are the bounded Zalo shape. Never
   surface raw provider content through API, UI, logs, or error text.

## TDD RED cases (ordered by plan phase)

### Gateway normalization and SDK contracts

1. `apps/zalo-account-gateway/__tests__/provider-message.test.ts`: an unsupported
   direct/group payload with valid `threadId`/`msgId` returns an unsupported record
   carrying only bounded identity/type/reason metadata; it must not carry raw
   `content`, URL, or secret fields. Current RED baseline is the reason-only
   result (`provider-message.test.ts:237-244`).
2. Same test: an own echo whose raw `isSelf` conflicts with verified UID is
   classified/quarantined deterministically; an inbound payload still resolves
   peer from `senderId`. Test both direct and group identity.
3. `packages/sdk/__tests__/zalo-account.test.ts` and
   `packages/sdk/__tests__/zalo-account-transport.test.ts`: v1 direct/group
   payloads emit `schemaVersion: 1`; legacy payloads without it parse as v1;
   unknown higher versions are rejected by the known parser with an explicit
   unsupported result, not a generic thrown validation error. Existing strict
   schema coverage is in `packages/sdk/src/lib/zalo-account.ts:228-301, 750-872`.

### Adapter, worker ingress, and canonical send

4. `integrations/zalo-account/__tests__/message.test.ts`: own echo stores
   `isSelf`, `recipientId`, and both provider/client IDs; peer remains `threadId`,
   and a connected-account UID cannot become the contact. Preserve the existing
   inbound/self cases at lines 94-133.
5. `apps/worker/__tests__/zalo-account-events.test.ts`: two different transport
   events with the same provider ID but different payload metadata are both
   admitted to reconciliation, while replaying the same `eventId` remains one
   job; job identity is workspace/account/thread/provider scoped. Current direct
   job assertion is at lines 282-328 and omits event ID/workspace from the hash
   (`apps/worker/src/events/zalo-account/handler.ts:164-188`).
6. A worker/received-message test (extend
   `apps/worker/__tests__/integration-worker-incoming-message.test.ts` or
   `received-message.test.ts`): own echo arrives before send result for text,
   image, file, and a command returning multiple provider IDs; exactly one
   outgoing row remains after reconciliation, all provider IDs are retained for
   lookup, no echo automation runs, and a repeated job is idempotent.
7. A canonical-send/worker test (extend
   `packages/business/__tests__/zalo-account-canonical-send.test.ts` and the
   send-message handler tests): a send result containing N IDs reconciles all N;
   a failed reconciliation produces a retryable/visible diagnostic, not a silent
   success, while an unknown provider outcome is never resent.

### Group durable identity and order

8. `packages/business/__tests__/zalo-account-group-inbox.service.test.ts` plus a
   repository-level test: duplicate group message, late duplicate, own echo before
   applied send attempt, undo-before-message, and retry after a DB failure produce
   one durable identity/message and no policy bypass. Keep the existing policy
   epoch and pending recovery assertions (`group-inbox.service.test.ts:74-114`);
   do not treat an admitted unpublished identity returning `isNew: true` as a
   duplicate bug.
9. A Zalo-only order test: later-arriving provider timestamps do not regress
   conversation `lastActivityAt`; out-of-order rows follow the explicitly chosen
   ordering rule. Current generic persistence uses ingestion time
   (`received-message.ts:1320-1342`) and group persistence uses identity time
   (`group-inbox-repository.ts:127-139, 243-253`).

### UI and public read

10. `apps/builder/src/features/messages/components/__tests__/zalo-account-group-message.test.tsx`:
    old payload without `schemaVersion` still renders sender/quote/mentions;
    v1 renders normally; an unknown/unsupported payload renders a localized,
    non-empty placeholder and never raw JSON. Existing legacy group parsing tests
    are at lines 23-70.
11. `apps/builder/__tests__/zalo-accounts-public-api.test.ts` (or the existing
    messages public API test): `messages.list/get` returns the bounded Zalo
    placeholder metadata and no raw provider body/URL; legacy rows remain
    readable through the generic path (`apps/builder/src/features/messages/api/public.ts:149-213`).

## Resource ceilings and failure behavior

- Reuse current normalized limits: text max 20,000, attachments max 10, quote
  text max 20,000, message type max 100, and mentions max 100 (SDK limits at
  `packages/sdk/src/lib/zalo-account.ts:216-279`). Fix the normalizer's
  `slice(0, 101)` to avoid admitting an item the SDK rejects
  (`apps/zalo-account-gateway/src/runtime/provider-message.ts:184-195`).
- Diagnostics are an allowlist, not a payload dump: workspace/account/inbox
  route IDs, thread type, hashed or length-capped thread ID, provider/client ID,
  msg type, schema version, and an enum reason only. Cap each string (for
  example, 200 chars), emit at most once per stable provider identity/reason,
  and never log text, parsed objects, attachment URLs, cookies, IMEI, user-agent,
  or access tokens. Use the repository pino logger; no `console`.
- Unsupported with valid identity is persisted once, with zero media downloads,
  zero automation, and no provider send. Missing identity is diagnostic + drop;
  guessing a contact is unsafe. Known DB/Redis failures throw into the existing
  bounded retry (default two attempts/5s exponential for message jobs); retries
  must hit stable source/identity keys. Do not auto-retry a provider write whose
  outcome is unknown (`docs/zalo-account.md:31-36, 173-184`).
- Keep the change Zalo Account-only. Do not add a media archive/history/sticker
  store, alter other integration job policies, or introduce a new queue/event
  framework.

## ZaloCRM reference patterns (not a design to copy)

- `ZaloCRM/backend/src/modules/zalo/zalo-listener-factory.ts:622-725` keeps
  `msgId`, `cliMsgId`, timestamp, thread, and `isSelf`; self messages resolve the
  contact/thread identity from `threadId`, while inbound messages use sender UID.
  Its history fallback derives self-thread from `idTo` and inbound-thread from
  sender UID (`:857-871`).
- `ZaloCRM/backend/src/modules/chat/message-handler.ts:298-372, 375-455`
  demonstrates atomic own-echo claiming and unique-ID duplicate handling. These
  are useful test ideas only; ChatbotX's canonical send/source-ID contracts remain
  authoritative.
- Do **not** copy ZaloCRM's raw payload logging around listener lines 417-425,
  439-443, 462-464, or 524-526; it conflicts with this plan's no-raw-content
  diagnostic boundary.

## Unresolved decisions for the plan author

- Choose whether the Zalo timeline must be provider-chronological or only
  monotonic for conversation activity. The current shared message contract stores
  ingestion `createdAt`; changing it globally is out of scope.
- Define the exact localized placeholder key/reason enum. Keep it machine-safe
  and stable; do not expose provider error text.

Status: DONE
Summary: Verified the Zalo Account receive/echo contract, strict schema and queue behavior, multi-ID reconciliation gap, unsupported-message drop path, and current UI/public read path; enumerated bounded TDD RED cases and failure ceilings.
Concerns/Blockers: No code or test changes were made. Chronological timeline semantics and the final placeholder reason labels require a plan-level product decision.
