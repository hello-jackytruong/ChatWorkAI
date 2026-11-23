---
title: "Phase 1: Start — ledger, transport and queue"
status: completed
effort: 12h
---

# Phase 1 — Start: ledger, transport và queue

## Mục tiêu / dependencies

Đặt nền tảng cho M01, M06, M10–M16, M18–M21: hai bảng main DB Zalo-only, service→repository, downloader Node-only constant-memory, CAS lease, immutable private key và queue dedicated. Phụ thuộc review [thiết kế đề xuất](./reports/scope-and-design.md#persistence-contract-proposed-no-ddl-executed), uploader hiện có và low worker; không chạy DB/network live trong lúc authoring.

Evidence cần re-check trước code: parser hiện chỉ chọn image/file tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/provider-message.ts:90-129`; outbound schema cũng chỉ `image|file` tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/src/lib/zalo-account.ts:205-214`; shared uploader hỗ trợ Readable PUT tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/filesystem/src/lib/uploader.ts:76-101`, còn helper URL hiện buffer tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/filesystem/src/lib/upload.ts:166-194`; low process đăng ký side consumers tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/low/worker.ts:155-207`.

## Files — action inventory

Create (future paths, not existing claims):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/schema/zalo-account-media.ts` — `ZaloAccountMediaAsset`/`Reference`, state enum, indexes/FKs.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/relations/zalo-account-media.ts` — workspace/account/asset/reference relations.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/zalo-account-media/repository.ts` and `index.ts` — scoped CRUD, claim/CAS, keyset queries.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/service.ts`, `index.ts`, `types.ts` — validation, orchestration, cache/events only here.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/worker-config/src/queues/zalo-account-media/index.ts` — queue/job types, deterministic IDs and priorities.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/zalo-account-media/bounded-download.ts` and `handler.ts` — worker-only HTTPS/spool/PUT and state machine.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/policy.ts` — one server-only feature-switch/limit accessor, exported through media service; `ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED` defaults false, shared by registrar/worker/scheduler without changing other channel flags.
- Tests: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/zalo-account-media-schema.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-media-service.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-media-downloader.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/worker-config/__tests__/zalo-account-media-queue.test.ts`.

Modify (enumerated; no “update all callers”):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/schema/index.ts`, `types.ts`, `relations/index.ts`, `repositories/index.ts` — exports/type and both relation import + spread.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/index.ts` and package `exports` in `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/package.json` only if a narrow subpath is needed — export Edge-safe metadata/service; Node stream/DNS/sharp stay worker-only.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/.env.example` — document only the new default-off media switch; do not read/edit live .env or change existing channel defaults.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/worker-config/src/lib/types.ts`, `lib/connection.ts`, `index.ts` — queue enum/export and exhaustive `queueGroupByName` (`zaloAccountMedia: bulk`).
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/low/worker.ts`, `__tests__/low-worker-boot.test.ts` — register dedicated consumer in existing low process only; call `setGlobalConcurrency(1)` during worker boot, never module import/build/fakeQueue.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/drizzle/<generated>_zalo_account_media/migration.sql` — generated/inspected additive SQL only.

No delete: no existing channel hydrator, Attachment/Message shard schema, shared LOW/HEAVY concurrency, uploader API, optimizer default, process entry, or migration is deleted/rewritten.

## TDD — RED before implementation

1. Baseline (must pass before new tests): `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run src/media/__tests__/optimize-stored-image.test.ts src/media/__tests__/resolve-media-url.test.ts`; `VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/low-worker-boot.test.ts`; `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/workspace-purge-coverage.test.ts`.
2. Add the listed schema/service/downloader/queue tests first, then run each focused file with `VITEST_MAX_WORKERS=1`; they must fail for missing tables/exports, missing CAS transitions, missing spool/queue behavior and missing `globalConcurrency=1`. Unit tests may mock HTTP/S3 clients, but no fake production behavior or weakened assertions.
3. RED matrix: reject unindexed workspace/account FKs and cross-workspace identity; reject URL-as-identity; reject private/redirect/DNS/MIME/size violations; reject full-buffer allocation and multipart; reject lease-lost finalization, duplicate job/object, and other-channel mutation.

## GREEN — ordered implementation

1. Define explicit enums/states and columns from the proposed contract: `workspaceId`, `accountId`, scoped resource identity/version, encrypted source locator, provider expiry, attempts/error/lease, candidate/final key/checksum/size/MIME/name, dimensions/duration provenance, projection/reconcile/deletion metadata. Use `sharedColumns`; every FK leads an index; reference pointers to shard rows have no cross-shard FK. Add unique owner+slot+role+revision and partial due/lease indexes. Keep asset row as outbox; no third run table.
2. Implement repository methods with workspace+account predicates on every read/write: register idempotently, claim with token/lease, renew, finalize only if token is current and checksum/size match, record `source_missing`/terminal failure, and rebind reference by CAS. Business service accepts `tx?` and owns validation/cache/events; app/worker/integration never imports `db`.
3. Implement worker-only transport: HTTPS, port 443/no credentials, validated pinned DNS per redirect (including mapped IPv6/private ranges), <=3 hops, 60s deadline, connect/idle 10s, cancel body on reject. Stream into task-owned mode-0600 spool with running size/hash/magic checks and backpressure; upload a `createReadStream` with exact `ContentLength`, SHA metadata and private ACL where supported through existing `uploader.putObject`; no `arrayBuffer`, full original Buffer or multipart. `finally` removes temp; bounded age scavenger removes only own stale files.
4. Generate deterministic private keys only after staging checksum and binding the scoped conversation: message media uses `workspace/<workspaceId>/zalo-account/<accountId>/conversations/<conversationId>/assets/<assetId>/<role>/<sha256>.<safeExt>`; profile/sticker resources use `workspace/<workspaceId>/zalo-account/<accountId>/resources/<kind>/<ownerHash>/<assetId>/<role>/<sha256>.<safeExt>`. Validate `HEAD` before final state. Keep bounded outstanding work (producer cap 50/tick and a hard ceiling of50 waiting/delayed transfer jobs (remaining backlog stays in indexed DB outbox)), select accounts fairly, and promote due work by age (resource/backfill waiting>=5min is promoted to priority10) so continuous live input cannot starve old resource/backfill work. Queue worker concurrency=1 and BullMQ global concurrency=1 across replicas; register shutdown abort before `worker.close()` and use `withBlockedOwnerGuard`.
5. Keep storage and projection independent: stored bytes may be true while shard projection is pending; projection failure is recoverable. Mark archival target `keepOriginal` before any shared optimization, but do not change non-Zalo optimizer defaults. Historical overwritten bytes are not claimed recoverable.

## Tracked implementation tasks (leave unchecked)

- [x] Add the two-table schema, relations, types and repository exports with all leading FK indexes.
- [x] Add `ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED=false` config and claim/write guards; preserve reads when disabled.
- [x] Add service validation, natural identity, CAS lease/finalize and redacted status transitions.
- [x] Add worker-only pinned-HTTPS spool/checksum/known-length PUT with abort and temp scavenging.
- [x] Add dedicated queue definition, producer cap/aging fairness, low-process registration and global concurrency boot call.
- [x] Add RED tests before each implementation slice and retain other-channel regression fixtures.
- [x] Generate and inspect, but do not apply, the additive migration SQL.

## REFACTOR boundaries

Keep transport/storage mechanics in `apps/worker` and persistence in database/business; no gateway `zca-js` import in business/worker. Keep future media API out of this phase. Do not add a generic media registry, distributed semaphore, bucket policy, or new container. Preserve exact public outbound attachment schema.

## Tests after GREEN / acceptance

Run focused tests above plus `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/worker-config exec vitest run __tests__/zalo-account-media-queue.test.ts`, worker downloader, service and database schema tests. Then sequentially run `pnpm --filter @chatbotx.io/database check-types`, `@chatbotx.io/business`, `@chatbotx.io/worker-config`, `worker`, `@chatbotx.io/filesystem`, `@chatbotx.io/sdk`; finish phase lint later, never `db:migrate`. Acceptance is observable: two replicas never exceed one transfer; 64MiB fixture has bounded chunks/disk, original SHA never changes; same event converges to one scoped asset/ref; two workspaces cannot read/collide; stale lease cannot finalize; no existing-channel test diff.

## Security, budgets, risks, rollback

Budgets: image/GIF 10MiB, file 25MiB, video 64MiB, audio 16MiB, avatar/cover/thumbnail/poster 2MiB, sticker 8MiB; <=12 resources/message, <=3 sticker variants; disk target one largest original + one image derivative workspace (~96MiB), not a total RSS promise. Risk H: DNS rebinding/SSRF or stale worker overwrites bytes—pin each hop, CAS token, private key and quarantine stale object. Risk H: schema drift/unindexed FK—run database purge/index tests and inspect generated SQL. Risk M: global limit configured during fakeQueue/build—test boot ordering and keep call in low boot only. Rollback: disable enqueue/claim, continue authorized reads, drain/abort workers, retain ledger/object; no table/object deletion.

Các command typecheck/regression/coverage đầy đủ: [verification commands](./reports/verification-commands.md). Mọi test mới được viết RED trước implementation; tài liệu này không xác nhận đã chạy chúng.
