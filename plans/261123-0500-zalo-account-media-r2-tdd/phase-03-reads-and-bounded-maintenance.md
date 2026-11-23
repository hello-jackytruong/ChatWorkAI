---
title: "Phase 3: Reads and bounded maintenance"
status: completed
effort: 10h
---

# Phase 3 — Reads và maintenance bounded

## Mục tiêu / dependencies

Hoàn thành M11, M12, M15–M18 và M22–M23 (đồng thời hoàn tất đọc lại M04/M07): status/retry truthful, scoped signed download, bounded existing-row backfill và DB↔R2 reconciliation. Phụ thuộc asset/reference registrar và worker Phase 1–2. Đây là kế hoạch cho các API future; các tên route bên dưới là **proposed**, không phải assertion rằng chúng đã tồn tại.

Evidence: shared media URL resolver chỉ hydrate các kênh khác tại `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/media/resolve-media-url.ts:11-19,139-194`; existing public Zalo router is mounted at `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/routers/public.ts:133-159` and uses token scope at `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/api/public.ts:26-99`; uploader signing is generic at `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/filesystem/src/lib/uploader.ts:126-150` and must not be treated as authorization; existing rows may be sharded, so backfill must route by message timestamp.

## Files — action inventory

Create (future paths, not existing claims):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/read-service.ts` — scoped projection/status, deleted-parent checks, signed authorization and maintenance orchestration.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/zalo-account-media/maintenance.ts` — bounded backfill/reconcile producers and keyset cursors; no global run table.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/schedule/handlers/recover-zalo-account-media.ts` — proposed bounded outbox/lease recovery handler; no new scheduler process or run table.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-media-read-service.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/__tests__/zalo-account-media-maintenance.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/message/__tests__/list-for-conversation.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/__tests__/to-resource.test.ts`.

Modify (enumerated; no “update all callers”):

- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account-media/service.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/zalo-account-media/repository.ts`, `types.ts` — status transitions, retry classifier, scoped read/download authorization, backfill/reconcile methods.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/api/operations.ts`, `api/public.ts`, `schema/resource.ts`, `schema/errors.ts` — proposed `listMedia`, `getMedia`, `authorizeMediaDownload`, `retryMedia`, `backfillMedia`, `reconcileMedia` procedures, using the existing mounted `zaloAccountsPublicRouter`.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/message/list-for-conversation.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/media/resolve-media-url.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/lib/to-resource.ts` — batch projected media into normal conversation/account reads without unsigned keys or N+1 provider/storage calls.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/worker-config/src/queues/schedule/index.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/schedule/worker.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/schedule/handlers/register-schedules.ts` — add proposed recovery job enum/dispatch/registration at the existing schedule surface; no separate scheduler.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/media-public-scope.test.ts`, `public-spec-operations.test.ts`, `public-spec-mcp.test.ts` — route/scope/spec contracts.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/worker/src/zalo-account-media/handler.ts`, `bounded-download.ts` — classify timeout/408/429/5xx/storage transient vs 404/410 proven source-gone; respect Retry-After <=15m, max 5 attempts, 30s exponential base+jitter.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/message/message-repository.ts` only if the existing `UpdateAttachmentParams` must gain `thumbnailPath`/`name`; enumerate every implementation and caller in a RED report, otherwise leave it untouched.
- `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/media/__tests__/resolve-media-url.test.ts`, `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/media/__tests__/optimize-stored-image.test.ts` — regression that Zalo private originals do not enter generic hydration/overwrite paths.

No delete: no generic public presigner, existing media UI route, provider history fetch, or other-channel hydrator is removed; no URL-only row is called stored merely because it remains readable.

## TDD — RED before implementation

1. Baseline: `VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/media-public-scope.test.ts __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts`; `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run src/media/__tests__/resolve-media-url.test.ts src/media/__tests__/optimize-stored-image.test.ts`; `VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run __tests__/enqueue-attachment-downloads.test.ts`.
2. Write and run new tests first; they must fail before implementation for: account/workspace/owner mismatch; missing/deleted parent Message or `deletedAt` set; pending/downloading/stored/failed/expired/source_missing projections; transient retry/Retry-After/terminal forbidden vs proven expiry; rotating URL retaining identity; wrong role/conversation; short signed URL and read-only mutation rejection; backfill keyset and shard routing; reconcile dry-run/outage safety.
3. RED public-contract tests must use proposed operations and assert their output is machine-usable, GET for read/status/download authorization only, POST for retry/backfill/reconcile, proper `.errors()`/scope, and no recalled-content bypass. `channels` token alone is insufficient for content read/download; use account + conversation/owner/member permission contract.

## GREEN — ordered implementation

1. Implement service reads that batch-resolve references by `(workspaceId, accountId)` and owner pointers; return safe status, role, metadata, `source_missing` and redacted errors. Never issue provider/network/HEAD calls during conversation reads and never expose encrypted locator, raw provider URL, or object key as an identifier.
2. Authorize download by media-reference ID, account, owner and current parent Message state. Explicitly deny a missing parent or current `Message.deletedAt` (including normal Zalo projection), not merely hidden UI; undo retention does not grant a new viewer. Only after this check return a proposed five-minute signed URL from the existing uploader convention; already-issued bearer URLs remain valid until TTL because instant revocation is not promised.
3. Retry only eligible assets with CAS lease and current source revision; use max five attempts, deadline/byte/MIME limits and error code taxonomy. `404/410` becomes `expired` only with positive source-gone evidence; generic 403 is `failed/forbidden`. Keep stored bytes/read path available when writes are globally disabled.
4. Implement proposed `backfillMedia`: only persisted supported URL-only Attachment/profile references, explicit account + bounded time/conversation window, keyset cursor containing shard timestamp, limit<=50, dry-run/register idempotence through natural identity. It must enqueue at most 50 per tick and never call a provider history API.
5. Implement proposed `reconcileMedia` dry-run first: DB→object `HEAD` pages<=50; object→DB prefix-limited `LIST` pages<=100 with continuation and max runtime. Missing referenced object is a repair signal, not deletion; DB/storage outage is unknown, never absence. Delete candidate only with no references, no live claim, >=24h grace, second independent confirmation and durable deletion intent from Phase 4.
6. Wire public procedures through the same business service as private callers. Use `workspaceTokenAuthAPIForScope` only for workspace entry, then enforce account/owner/member scope and channels-management authorization for maintenance. Do not add a UI-only implementation or an arbitrary URL/objectKey input.

## Tracked implementation tasks (leave unchecked)

- [x] Add batch reference projection to `list-for-conversation.ts`, `resolve-media-url.ts` and Zalo account/group resource shaping.
- [x] Add parent `deletedAt`/missing-owner authorization checks before every new signed download.
- [x] Add retry classifier, CAS claims, five-attempt budget, `source_missing`/expired truth and redacted status output.
- [x] Add proposed public read/retry/backfill/reconcile procedures with correct scopes, methods, errors and spec tests.
- [x] Add bounded existing-row backfill with account/time/conversation filters, shard timestamp cursor and <=50 limit.
- [x] Add dry-run DB↔object reconciliation with HEAD/LIST continuation, outage-as-unknown and no orphan delete.
- [x] Add proposed scheduled recovery enum/dispatch/registration and bounded handler; keep queue correctness in DB.

## REFACTOR boundaries

Keep scope/auth/response shaping in builder, business semantics in `packages/business`, raw SQL keyset mechanics in the repository and HEAD/LIST network I/O in the worker. Keep signed read authorization separate from object deletion. No provider calls, new media player, history crawler, generic Attachment migration or operation/run table.

## Tests after GREEN / acceptance

Run all RED files plus `VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/media-public-scope.test.ts __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts`, business read/service tests, worker maintenance tests, and existing `attachment-url.test.ts`/`message-item-attachments.test.tsx`. Sequential typechecks: `builder`, `worker`, `@chatbotx.io/business`, `@chatbotx.io/database`, `@chatbotx.io/sdk`, `@chatbotx.io/filesystem`. Acceptance: no N+1 reads; deleted/missing parent cannot sign; wrong workspace/account cannot read; every backfill request resumes from cursor and <=50; reconcile is dry-run and outage-safe; status/retry is truthful; proposed routes appear in public spec with scopes and no raw locator.

## Security, budgets, risks, rollback

Risk H: generic presign or UI hiding leaks recalled/private content—check parent `deletedAt` in service immediately before signing and test normal + recalled projections. Risk H: orphan deletion during DB outage—require two confirmations/grace and treat outage as unknown. Risk M: unbounded backfill/reconcile—hard page/request/runtime caps and continuation cursor. Risk M: retry storm—CAS claim, max five, Retry-After cap and priority aging. Rollback removes enqueue/maintenance writes and public mutation procedures, leaves stored reads/ledger; revoke only newly issued URLs by letting TTL expire, no object/table cleanup during rollback.

Các command typecheck/regression/coverage đầy đủ: [verification commands](./reports/verification-commands.md). Dùng tối đa1 Vitest worker; chạy scope tuần tự, không bật dev server hoặc chạm production khi thực thi unit gate.

Public API completion includes the cli-mcp-docs runbook: unique operationId/path-derived command names, public spec/MCP and CLI loader regression, docs update only for the shipped operations. No new CLI/MCP runtime implementation is needed for normal spec-derived procedures. Normal read projection must batch signed Zalo account/group/contact avatar resources; raw private keys must never replace avatarUrl as if they were browser URLs.
