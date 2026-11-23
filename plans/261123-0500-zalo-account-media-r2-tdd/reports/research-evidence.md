# Read-only source evidence

Date: 2026-11-23. Two bounded research delegates; no source edits, database, live account or storage calls. CodeGraph is present but CLI unavailable; native source inspection used.

## Existing paths and constraints

| Source owner | Confirmed evidence | Planning implication |
|---|---|---|
| `apps/zalo-account-gateway/src/runtime/provider-message.ts`, `attachmentOf` | Picks one image/file URL; drops additional metadata/resource types | Typed, bounded inbound capture separate from send contract |
| `packages/sdk/src/lib/zalo-account.ts`, `zaloAccountAttachmentSchema` | Same strict image/file schema used inbound/outbound | Do not widen outgoing capabilities accidentally |
| `integrations/zalo-account/src/message.ts`, `incomingAttachments` | Both URL and originPath are provider URL; own echoes use same mapping | Register incoming and self-echo through same durability seam |
| `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts` | URL-only attachments; group payload cleared at publish/discard | Durable intent before clearing, only after group policy admission |
| `packages/business/src/media/resolve-media-url.ts`, `HYDRATION_CHANNELS` | Only Messenger/Instagram/WhatsApp | Adding Zalo to set alone does not implement storage |
| `packages/channel-registry/src/media-hydration.ts` | Shared buffer ceiling100MiB, optimized photo storage/random keys | Leave existing channels unchanged; do not repurpose for immutable Zalo originals |
| `packages/business/src/zalo-account/canonical-send.service.ts`, `enqueuePrepared` | URL sends already copy into public conversation storage | Existing behavior regression; private original must be protected before optimization |
| `apps/zalo-account-gateway/src/runtime/outbound-attachment.ts` | Outbound image/file downloads buffer up to10/25MiB | Not a streaming inbound mirror; no need change this sending adapter |
| `packages/business/src/media/optimize-stored-image.ts` | Overwrites object at same key, honors keepOriginal and target allowlist | Zalo-only protection and separate derivative key; test queued jobs too |
| `packages/database/src/sharding/message/repository/sharded-message-repository.ts`, `reconcileOutgoingSourceId` | Merges attrs then deletes duplicate echo attachments/messages | Preserve stable media references before destructive reconciliation; cross-store recovery, not fake atomicity |
| `packages/database/src/schema/attachment.ts` and shard schema | Compressed hypertable; Message/Attachment live across shards | Zalo main-DB ledger; keep both parent-message and attachment timestamps for lookup/update |
| `packages/database/src/repositories/message/message-repository.ts`, `UpdateAttachmentParams` | Existing updates include originPath/MIME/size/dimensions; not thumbnail/name | Narrow additive interface only if required; enumerate implementations |
| `packages/business/src/media/attachment-row.ts` | Zero-row attachment update throws | Stored bytes and projected reference are separate success states |
| `packages/filesystem/src/lib/uploader.ts` | Readable PUT, abort, HEAD/delete/list; R2 ACL stripped | Reuse known-length streaming PUT; no new storage SDK |
| `packages/filesystem/src/lib/upload.ts` and `bounded-fetch.ts` | Capped but accumulates Buffer; per-hop validation optional | Preserve helper behavior; new worker-only bounded spool transport |
| `packages/filesystem/src/lib/node-upload.ts` | Separate unbounded URL helper; multipart wrapper hides abort/options | Do not reuse blindly |
| `packages/business/src/net/ssrf-guard.ts` | Preflight DoH followed by separate fetch resolution | Zalo downloader pins validated actual lookup without changing global guard |
| `apps/worker/src/low/worker.ts` | Shared low concurrency30; already hosts concurrency1 side consumers | Dedicated queue, same process, no receipt slot starvation |
| Installed BullMQ `classes/queue.d.ts`, `setGlobalConcurrency` | API exists | Bound replicas without inventing semaphore framework |
| `packages/business/src/message-cleanup/service.ts` | Cleanup deletes rows then object paths; object failures logged; processPending not wired to cron | Do not activate/change global cron; new Zalo cleanup owns durable manifest and ref checks |
| `packages/database/src/repositories/workspace-purge/tables.ts`, `packages/business/src/workspace-lifecycle/purge-batch.ts` | Bounded main/shard drains and timeout helpers | Drain refs/assets child-first while keeping storage deletion manifest |
| `packages/connections/src/zalo-account-teardown.ts` | Stops runtime, transaction callback no deletion | Ordinary disconnect retains archive; delete lifecycle handled separately |
| `docs/deployment.md`, `deploy/r2/public-reader.mjs` | Private workspace prefix, public reader limited to public/, r2.dev disabled | No bucket-global policy change; verify real environment before enable |

## ZaloCRM reference and limits

Reference repo: `/Volumes/DevSSD/Work/GitHub/ZaloCRM`.

- `backend/src/modules/chat/message-handler.ts`: mirrors image/video/file/GIF/voice/audio and known nested params URLs; real empty200 after desktop uploads motivates bounded retry. It buffers/compresses and has no durable archival ledger; copy field evidence, not implementation.
- `backend/src/modules/zalo/zalo-message-helpers.ts`: msgType+content.action dispatch, link/bank/QR variants and album fields. Link webpage/bank HTML targets are NOT media download targets.
- `backend/src/modules/contacts/zinstant-proxy-routes.ts`: getStickersDetail static/sprite/WebP/frame metadata; implement account-scoped retrieval without public any-account fallback.
- `backend/src/modules/contacts/zalo-profile-capture.ts`: provenance/source adapters and fill-only profile merge. Storage refresh should not overwrite CRM-edited profile fields.
- `backend/src/modules/zalo/zalo-history-backfill.ts`: history crawler belongs to checklist section9, excluded here; future callers use same media registration contract.

## Test owners verified

- Filesystem: `__tests__/bounded-fetch.test.ts`, `upload-from-url.test.ts`, `upload-writer.test.ts`, `r2-uploader.test.ts`.
- Business: `__tests__/zalo-account-canonical-send.test.ts`, `zalo-account-group-inbox.service.test.ts`, `zalo-account-friend-sync.test.ts`; `src/media/__tests__/resolve-media-url.test.ts`, `optimize-stored-image.test.ts`.
- Worker: `__tests__/coexist-attachment-download.test.ts`, `enqueue-attachment-downloads.test.ts`, `zalo-account-group-recovery.test.ts`.
- Channel registry: `__tests__/media-hydration.test.ts`.
- Database: `__tests__/workspace-purge-coverage.test.ts`, `workspace-purge-repository.test.ts`, `purge-fk-indexes.test.ts`.
- Builder: `__tests__/edge-instrumentation-graph.test.ts`, `media-public-scope.test.ts`, `message-item-attachments.test.tsx`, `attachment-url.test.ts`, public spec tests.
- R2 reader: `node --test deploy/r2/public-reader.test.mjs`.

TDD: use `VITEST_MAX_WORKERS=1 pnpm --filter <workspace> exec vitest run <paths>`; do not run `test -- <path>`. Final implementation gate lint -> sequential touched types -> tests -> coverage>=80%; DB integration only in explicitly approved disposable environment. No tests executed during research.
