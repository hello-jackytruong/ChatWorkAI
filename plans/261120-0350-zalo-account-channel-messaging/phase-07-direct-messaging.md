---
phase: 7
title: "Direct messaging through existing pipelines"
status: pending
priority: P1
effort: "L"
dependencies: ["Phase 6"]
---

# Phase 7: Direct messaging through existing pipelines

## Goal

Support reliable 1:1 Zalo messaging through existing integration receive/echo and chat-send pipelines, with stable identity, dedupe, and media safety.

## Supported v1 matrix

| Direction | Supported | Explicitly unsupported |
|---|---|---|
| Inbound | Text, quote/reply metadata, image, file, own echo, delivered/seen/undo where canonical models support them | Group-to-Inbox, reactions, polls, calls, history backfill |
| Outbound | Text, reply/quote, image upload, file upload | Voice/video URL, sticker, card, forward, reaction, poll, group send |

Unknown payloads produce structured unsupported-provider telemetry without crashing consumers or fabricating empty messages.

## Identity/routing contract

- Route by a dedicated job envelope containing `IntegrationZaloAccount.id`, `workspaceId`, and `inboxId`; resolve all three predicates through a specialized path. Never send this channel through the generic identifier-only resolver; `zaloUid` is identity data only.
- Preserve thread type/ID, `msgId`, `cliMsgId`, sender/recipient, timestamp, type, quote, and `isSelf`.
- Inbound peer is `uidFrom`; own-echo peer is `threadId`/`idTo`; never create the connected account as its own Contact.
- Encode account + thread type + provider message ID into the normalized source/idempotency key. The guarantee covers configured transport retention/replay; if live/provider replay can exceed the canonical persistence lookback, stop and plan the smallest durable ledger/schema change.
- Handle both text and attachment result IDs. Never retry automatically after an ambiguous dispatch.

## Key files

Extend normalized Zalo schemas in `packages/sdk`, provider adapters/runtime listeners in gateway, the thin integration definition, Phase 5 worker bridge, and existing integration receive/echo/chat-send capability extension points. Reuse established object-storage/download validation services. Add fixture tests to gateway, integration, and worker workspaces.

## Tests before implementation (RED)

1. Fixtures cover user text, quote, image, file, echo, receipt, undo, malformed, and group discrimination.
2. Replay after restart creates one message; same numeric ID on two accounts cannot collide.
3. Crash after business commit but before stream acknowledgement uses a deterministic scoped job ID/business idempotency boundary and repeats no message, automation, webhook, or realtime effect.
4. Peer mapping resolves correct Contact and never self-creates.
5. Outbound text/reply/media records provider IDs; later echo reconciles without duplication.
6. Ambiguous send is actionable and does not invoke transport twice, even after result TTL/restart.
7. Media rejects oversize/MIME mismatch/private URLs/unsafe redirects/arbitrary local paths and proves zero SDK calls/retained objects on rejection.
8. Group payload creates no direct Contact/Conversation/Message.
9. Existing Messenger/WhatsApp/Telegram/Zalo OA suites remain green.

## Implementation steps (GREEN)

1. Freeze fixture-backed normalized schemas and supported matrix.
2. Subscribe to named gateway events; classify user/group before fenced publication.
3. Bridge direct receive/echo to existing integration jobs using persisted account route key.
4. Implement direct parse/profile/send adapter methods through transport only.
5. Reuse canonical received-message effects and echo/provider-ID settlement.
6. Add deterministic scoped BullMQ job IDs and a durable business-effect boundary before side effects. Outbound intent keeps the same client/command ID and terminal `unknown` across restart until echo/reconciliation proves outcome.
7. Transfer image/files through a fail-closed controlled temporary/object-storage path with redirect-by-redirect validation, bounded streaming, SSRF/MIME/size checks, and cleanup. Do not use the existing outbound-media fallback that returns the original URL on failure.
8. Map receipts/undo only through existing generic status contracts; otherwise emit typed unsupported telemetry.

## Refactor while green

Keep raw payload conversion at gateway/adapter, durable effects in worker, and exhaustive fixture-driven message switches. Use capabilities instead of new core channel-name branches.

## Tests after implementation

Run focused gateway, integration, direct-message worker, then full worker suites sequentially with one Vitest worker. Run final gates from `plan.md` afterward.

## Todo

- [ ] Freeze fixtures and supported matrix.
- [ ] Implement guarded normalization and route key.
- [ ] Bridge receive/echo into canonical jobs.
- [ ] Add outbound text/reply/image/file and result settlement.
- [ ] Add deterministic dedupe and ambiguous-send behavior.
- [ ] Add media safety/storage/cleanup and observability.
- [ ] Prove group isolation/current-channel regression safety.

## Success criteria and stop signals

Direct messages use normal Inbox behavior; replay/echo/restart do not duplicate; groups cannot enter 1:1 automation; unsupported payloads are non-fatal; media cannot bypass safety controls. Stop and replan if stable dedupe requires schema change or live fixtures contradict identity/echo semantics. Roll back by disabling Zalo send/receive while retaining channel management.
