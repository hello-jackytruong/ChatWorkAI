---
title: "Phase 2: Ingress and resource capture"
status: completed
effort: 12h
---

# Phase 2 — Ingress và resource capture

## Mục tiêu / dependencies

Hoàn thành M02–M10, M13–M14 và M21: mọi nguồn bytes hiện có được capture qua cùng registrar cho DM, own-echo, nhóm và history-shaped input; mở rộng capture video/voice/audio/GIF/card-media/avatar/cover/sticker nhưng không mở send/player/picker. Phụ thuộc Phase 1 schema, queue, downloader và service. Không crawl lịch sử/provider; không tự suy đoán bytes khi `source_missing`.

Evidence phải giữ đúng seam: gateway chuẩn hóa group attachment ở `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/provider-message.ts:157-198`; integration map hiện tại làm URL-only `IncomingAttachment` tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/integrations/zalo-account/src/message.ts:40-59`; group identity commit trước shard write tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:119-165` nhưng `markPublished` xóa payload tại `:256-260`; canonical echo reconciliation có thể xóa duplicate attachment/message tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/sharding/message/repository/sharded-message-repository.ts:948-980`.

## Files — action inventory

Create (future paths, not existing claims):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/src/lib/zalo-account-media.ts` — inbound-only bounded descriptor/resource schemas, source/role/provenance; never reuse outbound attachment schema for send.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/sticker-resource.ts` — account-scoped `getStickersDetail` batch<=20 adapter/cache and typed resource output only; this is not sufficient by itself, so wire the command through the existing gateway transport files below.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/registration.ts` — intent registration, natural identity, aliases and reference projection helpers.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-media-ingress.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/sticker-resource.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/integrations/zalo-account/__tests__/media-capture.test.ts`.

Modify (enumerated; no “update all callers”):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/src/lib/zalo-account.ts` — add inbound descriptor fields/refinements to both direct and group event envelopes (including descriptor-only video/voice/sticker), while keeping outbound `zaloAccountAttachmentSchema` at `:205-214` strict; update serialized SDK tests for no-text/legacy-attachment payloads.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/provider-message.ts` — extract known image/file/video/audio/GIF and validated card-media roles/params with bounded counts; preserve identity, source revision and `isSelf`.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zca-client.ts`, `runtime/ports.ts`, `transport/command-executor.ts` — add the typed account-scoped sticker-detail command and provider adapter dispatch; `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/src/lib/zalo-account.ts`, `packages/sdk/src/index.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/transport.service.ts` — add the command/result union, transport method and export. Do not expose a generic provider-call endpoint.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/integrations/zalo-account/src/message.ts` — pass descriptors to registration while retaining existing `IncomingAttachment` projection for supported UI fields.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts` — commit alias/rebind intent before entering the destructive shard reconciliation; recovery reads current references, never a stale payload attachment ID.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/integration/handlers/incoming-message.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/integration/handlers/received-message.ts` — invoke one registrar for direct, replay/history-shaped and own-echo events, before ACK/commit boundary.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/canonical-send.service.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/chat/handlers/send-message.ts` — pre-register outgoing private original/alias before existing public upload/optimizer/reconciliation seams; preserve command/send-attempt semantics.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/message/create-outgoing.ts:646-670` — add the Zalo-only registration/protection hook for Inbox/device/media-library uploads and copies, because these paths bypass canonical-send; preserve existing `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/filesystem/src/lib/upload.ts:49-79` behavior (no filesystem refactor unless a RED test proves a concrete need).
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/events/zalo-account/handler.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/src/device-session-flow.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/connections/src/connect-session-flow.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/connection/store-bindings-channels.ts` — preserve already-decrypted trusted QR displayName/avatar through the Zalo-only descriptor/binding seam; generic provider defaults and identity verification unchanged.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/service.ts:177-208`, `friend-sync.service.ts`, `group.service.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/integration/handlers/contact-profile-refresh.ts` — hook initial/reconnect account avatar capture plus friend/group/member avatar/cover only when supplied by current payload and owner surface; fill/revision CAS must not overwrite CRM edits.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/media/optimize-stored-image.ts` — recognize protected private Zalo targets and write only independent derivative; existing channel optimizer defaults remain unchanged.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/low/worker.ts` and existing boot tests — ensure capture jobs use the dedicated queue and never consume receipt/echo slots.

No delete: no existing history crawler, sender, player, picker, native revoke, shared hydrator, shared optimizer policy, or original object is deleted/repurposed.

## TDD — RED before implementation

1. Baseline: `VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/provider-message.test.ts __tests__/outbound-attachment.test.ts`; `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/integration-zalo-account exec vitest run __tests__/message.test.ts`; `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-canonical-send.test.ts __tests__/zalo-account-group-inbox.service.test.ts __tests__/zalo-account-friend-sync.test.ts`.
2. Add failing tests before implementation for: each typed resource and known card media; image/file/video/audio/GIF descriptors with source absent; DM/group/history-shaped shared registration; own-echo before/after send result and echo-first; avatar revision CAS and conditional cover; sticker static/WebP/sprite reuse; policy denial before group persistence; queued optimizer cannot overwrite protected original; repeated/replayed events converge without duplicate object/reference.
3. RED assertions must prove `source_missing` instead of fake success, reject link/bank webpage crawling, cap <=12 resources/message and <=3 sticker variants, retain provider duration/dimensions provenance, and keep outgoing `zaloAccountAttachmentSchema` strict. Include a two-workspace same IDs fixture and an injected mainDB/shard failure at every saga boundary.

## GREEN — ordered implementation

1. Add the inbound-only descriptor schema: `kind`, role, provider resource ID/version, deterministic slot, source locator(s), filename/MIME hints, size/dimension/duration hints, `sourceMissing` reason. Normalize `msgType`, `content.action`, `params` (including JSON and known typo variants) and only allow explicit known keys; never recursively fetch arbitrary URLs, link previews or bank-card webpages.
2. In each ingress path, derive natural identity `workspace+account+thread+providerMessageId+stableAttachmentId/slot+role`; add source revision for profiles and account/category/sticker/version identity for shared sticker assets. Register asset+reference and commit the alias/rebind intent before event ACK, before group payload discard, and before entering `reconcileOutgoingSourceId`'s destructive shard transaction. A DB registration failure must not ACK; queue publication failure remains repairable by indexed outbox scan. Group receive/send policy is checked before archive intent. Do not hold a main-DB transaction open across a shard call.
3. Route descriptor transfer to the Phase 1 queue with priority live=10, resources=20; maintain same-account sticker sharing only, never cross-account/workspace physical dedup. Persist supplied thumbnail/poster as a separate role/object and generate at most one bounded image preview per source using the existing encoder. Keep animated original intact; no video decode/transcode and no ffprobe dependency.
4. Add canonical outgoing alias registration before existing `uploadFileFromUrl`/`createOutgoing` path at `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/canonical-send.service.ts:185-232`, the shared send-message reconciliation at `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/chat/handlers/send-message.ts:1393`, and the Inbox/device/media-library `createOutgoing` attachment path at `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/message/create-outgoing.ts:646-670`. For user-provided outbound media, `sourcePolicy` is the trusted uploaded ChatbotX object/copy, not a second arbitrary provider-CDN fetch; if no checksum exists, hash via bounded `getObjectStream`. Commit the mainDB alias/rebind intent before the shard transaction, then bind/project after shard write and repair after either commit. `reconcileOutgoingSourceId` is not an atomic cross-store transaction; preserve stable provider/local IDs before its duplicate echo deletion and never rely on an outer mainDB transaction to fence it. Keep `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/filesystem/src/lib/upload.ts:49-79` unchanged unless a focused RED test proves otherwise.
5. Initial/reconnect account capture must use the LIVE authorization route, not only `saveAuthorization` (currently no production callers): worker authorization handler currently drops decrypted displayName/avatar, then calls `completeTrustedDeviceAuthorization`. Carry bounded trusted profile metadata server-side into the Zalo descriptor/binding, preserve verified UID and other provider behavior, and register from the committed bound account profile with replay-safe recovery. Never accept this override from a public/client field or add a getUserInfo crawl. Capture account/friend/group/member avatar and conditional cover from already-arriving connect/friend/group payloads only. If no source or no consuming profile surface exists, write `source_missing`/no intent rather than crawling or erasing the last good revision. Add sticker detail command only for inbound IDs lacking URLs, account-scoped cache and batch<=20.
6. Set `keepOriginal`/protected target before any existing optimizer job can run. The derivative key is separate and its projection status is independent of original stored status. A stale job may leave only a quarantine cleanup candidate after grace; it cannot replace current source revision or finalize after lease loss.

## Tracked implementation tasks (leave unchecked)

- [x] Add inbound descriptor schemas/refinements to both direct and group envelopes with no-text/legacy-attachment coverage.
- [x] Extend gateway normalization and integration mapping for all supplied media roles without widening outbound send input.
- [x] Commit media intent before ACK/group discard and before any destructive shard reconciliation.
- [x] Wire outgoing capture in canonical-send, shared send-message, and `create-outgoing.ts` Inbox/device/library seams.
- [x] Add trusted uploaded-object source policy, account avatar save/reconnect hook, profile CAS, and conditional cover capture.
- [x] Wire sticker command through ports, command executor, zca client, SDK union, transport service and export; keep it account-scoped/batched.
- [x] Add RED serialized gateway→event→worker, echo-race, avatar/CAS, sticker reuse and optimizer-protection tests before GREEN code.

## REFACTOR boundaries

Keep provider shape parsing in gateway/SDK, intent and auth-adjacent rules in business, raw persistence in repository, bytes in the Phase 1 worker. Do not widen `zaloAccountAttachmentSchema` or any public send input to video/voice/GIF/card/sticker. Do not add a generic cross-channel media table, history API, renderer or native operation.

## Tests after GREEN / acceptance

Run the RED files plus `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts`, gateway/integration/business tests above, and `VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/zalo-account-media-ingress.test.ts`. Sequential typechecks: `@chatbotx.io/sdk`, `@chatbotx.io/database`, `@chatbotx.io/business`, `@chatbotx.io/integration-zalo-account`, `zalo-account-gateway`, `worker`. Acceptance: valid supplied bytes for every M02–M09 role reach stored checksum; no-source cases are explicit; DM/group/echo/replay use one registrar; canonical echo retains one original/reference after shard cleanup; original SHA and outgoing behavior remain unchanged; all non-Zalo media tests pass.

## Security, budgets, risks, rollback

Enforce private object prefix, encrypted source locator, redacted error metadata, policy/account/workspace scoping, strict MIME magic and size caps from Phase 1. Risk H: ACK before intent or group policy bypass loses/archives unauthorized media—transactional registration gate and recovery tests. Risk H: older echo completion replaces newer avatar—source revision CAS. Risk H: two writes race with shard echo reconciliation—stable alias ledger and repair, never fake atomicity. Risk M: sticker detail leaks account scope—route only through account-owned gateway command/cache. Rollback disables descriptor enqueue and sticker lookup, preserves stored originals/references and current UI projections; no retention deletion.

Các command typecheck/regression/coverage đầy đủ: [verification commands](./reports/verification-commands.md). Dùng tối đa1 Vitest worker; chạy scope tuần tự, không bật dev server hoặc chạm production khi thực thi unit gate.

Integration gate: contract changes in shared connection/device flow are optional/default-unchanged and apply only to trusted Zalo metadata. Add first-connect/reconnect/replayed-authorization tests plus one existing non-Zalo device-provider regression before changing those signatures. Save media refs from profile data already persisted, not from a transient QR dialog cache.
