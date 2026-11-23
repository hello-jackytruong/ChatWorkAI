---
title: "Phase 4: Purge and production verification"
status: in-progress
effort: 6h
---

# Phase 4 — Purge, retention và production verification

## Mục tiêu / dependencies

Đóng M20, M23, M24 và release gate cho toàn bộ M01–M24: retention theo reference, undo không xóa archive, shared sticker an toàn, account/contact/inbox/workspace purge bounded, delayed old PUT không làm mất manifest, và xác minh production trước flag-on. Phụ thuộc Phase 1–3, generated migration được inspect, và explicit approval cho việc apply migration; không live DB/network trong lúc viết kế hoạch.

Evidence: purge tables hiện drain heavy children tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/workspace-purge/tables.ts:1-38,89-148`; bounded transactions/deadline dùng `withPurgeTimeouts`/`drainInBatches` tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/workspace-lifecycle/purge-batch.ts:38-102`; workspace purge service owns table loop tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/workspace-lifecycle/service.ts:360-409`; scheduled entry là `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/schedule/handlers/purge-workspaces.ts` và registration `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/schedule/handlers/register-schedules.ts:625-632`.

## Files — action inventory

Create (future paths, not existing claims):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/purge.ts` — reference-safe asset generation selection, closing barrier, manifest/delete intent and compensation.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-media-purge.test.ts` — reference-safe generation, closing barrier and delayed-PUT compensation tests.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/zalo-account-media-purge-coverage.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-media-production-gates.test.ts`.

Modify (enumerated; no “update all callers”):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/workspace-purge/tables.ts` — register both tables child-first/asset before account/workspace; if no FK reaches a table, add exact `NO_FK_WORKSPACE_TABLES` entry and leading workspace index.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/workspace-lifecycle/service.ts`, `purge-batch.ts` — bounded reference/asset drains, `WorkspacePurgeIncompleteError` on deadline/unknown upload generation, quota reconciliation unchanged.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/service.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/zalo-account-media/repository.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/purge.ts` — account/disconnect retention, shared-reference locks, closing barrier and object deletion outside DB transaction.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/schedule/handlers/purge-workspaces.ts`, `register-schedules.ts` — call existing lifecycle path only; do not activate/refactor generic MessageCleanup cron.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/workspace-purge-coverage.test.ts`, `purge-fk-indexes.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/workspace-lifecycle/__tests__/purge-batch.test.ts`, `service.test.ts` — add coverage for Zalo tables and incomplete/resume semantics.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/docs/zalo-account.md` only after implementation/release evidence — record final operational route/limits; no docs edit during this plan-authoring pass.

No delete: never drop the two tables, archive originals, existing shared objects, Message/Attachment rows, undo history, or manifest until post-retention proof; no generic cleanup cron changes.

## TDD — RED before implementation

1. Baseline: `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/workspace-purge-coverage.test.ts __tests__/purge-fk-indexes.test.ts`; `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run src/workspace-lifecycle/__tests__/purge-batch.test.ts src/workspace-lifecycle/__tests__/service.test.ts`; `node --test deploy/r2/public-reader.test.mjs`.
2. Write failing tests before purge code for: undo retains asset; shared sticker with two refs survives first delete; registration/deletion claim the same asset row lock; new ref cannot attach a deleting generation and receives a next generation; account disconnect retains archive; account/workspace purge drains refs before assets in <=100 batches; delayed old PUT after DELETE cannot erase/rebind current manifest; uncertain upload leaves parent purge incomplete and resumes next tick.
3. Add RED migration/index tests proving both workspace/account FKs are indexed and no generic shard DDL; add production-gate tests for feature flag off, private bucket/read staging, global queue=1, shutdown abort and other-channel regression. No test may use a fake “atomic” cross-store transaction.

## GREEN — ordered implementation

1. Before deleting an asset generation, acquire the asset row lock/claim and close admission to new references. Re-read reference count/current generation; a concurrent registration either attaches before the barrier or creates a new generation. Delete network objects outside the DB transaction with a durable manifest/deletion intent encoded on the asset row, then CAS deletionPhase của generation sang confirmed sau khi delete/late-write checks thành công; chỉ sau đó mới drain manifest row. A stale worker/PUT token cannot finalize current generation, but recognize DB lease alone cannot fence an already-issued object PUT; compensate/quarantine late objects after grace.
2. Extend workspace lifecycle child-first: references (<=100, keyset/skip-locked) → assets/manifest (<=100) → existing parents. Hold a closing barrier while any active upload generation/outcome is unknown; return `WorkspacePurgeIncompleteError` and leave parent workspace for next tick rather than cascade ledger prematurely. Use `withPurgeTimeouts`, deadline checks and no HTTP under DB transaction. Account/contact/inbox purge follows the same owner/reference rules; ordinary disconnect retains archive.
3. Preserve shared objects: only delete when no reference, no live claim, grace>=24h, second independent DB/storage confirmation and durable intent. Undo/recalled event alone never schedules media deletion. Profile revision cleanup is grace-based; referenced sticker assets cannot be evicted by TTL.
4. Inspect generated additive migration SQL, run schema/purge/index tests, then in an explicitly approved disposable environment run DB integration one file at a time and representative `EXPLAIN (ANALYZE, BUFFERS)` inside `BEGIN … ROLLBACK`. Apply migrations only after explicit user approval and before code deploy; do not perform it in this plan.
5. Production preflight: feature disabled, private bucket and reader authorization, pinned provider/CDN fixture inventory, abort/timeout cleanup, historical shard routing, own-echo races, two-workspace isolation, backlog bound/aging under continuous live input, and no more than one transfer across two workers. Roll out one bounded staging account, observe, then cohort; no live production enablement is implied by tests.

## Tracked implementation tasks (leave unchecked)

- [x] Add purge child-first entries/index coverage for both Zalo media tables and bounded ref/asset drains.
- [x] Add asset closing barrier, row lock/CAS generation selection, durable manifest/deletion intent and network-outside-transaction deletion.
- [x] Keep parent workspace purge incomplete while any upload generation/outcome is unknown; add delayed-old-PUT compensation test.
- [x] Add shared-sticker lock race, undo retention, disconnect retention and account/workspace purge retry tests.
- [x] Add proposed recovery schedule wiring and feature-off/abort/global-concurrency production gates.
- [ ] Generate/inspect migration and run disposable DB/index/EXPLAIN checks only after explicit approval.
- [ ] Record final operational route/limits in `docs/zalo-account.md` only after observed release evidence.

## REFACTOR boundaries

Keep purge logic in Zalo media service/lifecycle; do not change global `MessageCleanup` or shared channel storage semantics. Keep manifest/closing barrier in mainDB and object deletion outside transactions. Keep gateway/provider operations and new capabilities outside this phase. Do not delete plan/report files or add a third DB table.

## Tests after GREEN / acceptance

Run focused tests with `VITEST_MAX_WORKERS=1`: `pnpm --filter @chatbotx.io/database exec vitest run __tests__/workspace-purge-coverage.test.ts __tests__/purge-fk-indexes.test.ts __tests__/zalo-account-media-purge-coverage.test.ts`; `pnpm --filter @chatbotx.io/business exec vitest run src/workspace-lifecycle/__tests__/purge-batch.test.ts src/workspace-lifecycle/__tests__/service.test.ts __tests__/zalo-account-media-purge.test.ts`; `pnpm --filter worker exec vitest run __tests__/zalo-account-media-production-gates.test.ts`; `node --test deploy/r2/public-reader.test.mjs`. Then sequential typechecks: database, business, worker, worker-config, filesystem, sdk, builder. Final gate is `pnpm lint` → touched typechecks → tests → coverage>=80%; acceptance is measurable: no orphan/shared-data loss in race tests, purge never deletes uncertain manifests, all batches bounded/resumable, R2 auth denies unauthorized reads, and other channels show no changed outcomes.

## Security, budgets, risks, rollback

Budgets: purge/ref deletion <=100 rows/batch, object LIST<=100 with continuation, HEAD<=50, stop before lock/deadline; network never inside DB transaction. Risk H: delayed PUT arrives after parent delete—closing barrier, incomplete marker, generation token and grace cleanup. Risk H: shared sticker race—same-row lock/CAS and next generation. Risk H: parent cascade erases manifest—child-first drain and block parent while upload unknown. Risk M: production R2 policy mismatch—private reader staging and explicit no-public-original check. Rollback: disable new producers/maintenance and keep reads; stop worker after aborting active I/O, leave ledger/object/manifest; do not run destructive cleanup or drop migration. Resume only after signals are green.

Các command typecheck/regression/coverage đầy đủ: [verification commands](./reports/verification-commands.md). Dùng tối đa1 Vitest worker; chạy scope tuần tự, không bật dev server hoặc chạm production khi thực thi unit gate.
