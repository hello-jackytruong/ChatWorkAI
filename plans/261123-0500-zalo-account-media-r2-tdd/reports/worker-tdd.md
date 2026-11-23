# Worker, transport, queue and lifecycle TDD evidence

Date: 2026-11-23. Worktree: `/Users/jacky/.codex/worktrees/zalo-account-media-r2/ChatWorkAI`.

## Delivered

- Dedicated `zaloAccountMedia` bulk Redis queue, hosted in the existing low process. Boot awaits `setGlobalConcurrency(1)` before constructing its concurrency-one consumer; owner guard and coordinated shutdown abort are present. No process/container/entry added.
- Scoped deterministic job IDs, live/resource/backfill priorities, actual promotion of already-queued work after five minutes, producer admission serialized by a token Redis lock, and a 50 waiting/delayed/prioritized transfer ceiling. Excess work remains in the indexed DB asset outbox. Failed/completed jobs are removable so the outbox can redispatch.
- Pinned Node HTTPS transport vets every DNS A/AAAA answer and every redirect; accepts HTTPS port443 without credentials only for `zdn.vn`/subdomains; rejects private/reserved/mapped IPv6, encoding, oversized or truncated bodies, false image magic, and excess redirects. Connect/idle10s, download60s; transfer105s under a120s DB lease. Actual provider host expansion requires reviewed fixtures.
- Streaming SHA256 plus at most512B magic prefix, mode0600 spool under private mkdtemp, backpressure and actual byte limits. The64MiB video test produces64KiB chunks without creating a full-size media Buffer. Trusted storage sources use bounded `getObjectStream` with abort instead of CDN transport.
- Immutable private PUT uses a file Readable, exact `ContentLength`, SHA metadata and private ACL through the uploader; no multipart. Durable candidate recorded before PUT; actual HEAD size/SHA checked before completion. Abort signals reach storage GET/HEAD/DELETE and PUT. Temp finally cleanup and bounded old-owned-directory scavenging are implemented.
- Separate sharp image preview with16M input-pixel cap,10s encoder deadline,1024px bounds and2MiB output cap; no original overwrite or ffmpeg. Original archival and generated preview use separate manifest assets/roles. Actual image dimensions are nullable if metadata cannot be decoded; video duration is not invented.
- Existing scheduler recovers unstarted expired leases, dispatches the due outbox fairly through the business service, and drives bounded closing-manifest deletion even with writes disabled. Deletion includes all historical candidate keys, stops on storage failure, and confirms the durable intent only after storage deletion.
- Workspace teardown invokes the manifest drain before deleting messages/analytics: closes bounded account scopes, releases references, drains only confirmed ledger rows, signals the existing scheduler, and throws `WorkspacePurgeIncompleteError` until remote deletion is confirmed. Workspaces without media return immediately; ordinary disconnect behavior is untouched.

## RED → GREEN

Commands below use `VITEST_MAX_WORKERS=1` and were run with no live provider/storage/database calls.

1. `pnpm --filter worker exec vitest run __tests__/zalo-account-media-downloader.test.ts`: RED missing bounded-download module; GREEN18 initial transport cases, subsequently expanded magic,64MiB, abort/deadline, truncation and scavenger cases.
2. `pnpm --filter @chatbotx.io/worker-config exec vitest run __tests__/zalo-account-media-queue.test.ts`: RED missing queue module; GREEN2 initial ID/priority cases. Admission tests subsequently prove concurrent producers leave room at50 and age promotion still occurs with a full queue.
3. `pnpm --filter worker exec vitest run __tests__/zalo-account-media-handler.test.ts`: RED missing handler; GREEN5 cases for claim ownership, candidate-before-PUT, known-length private PUT, HEAD-before-complete, cleanup and dependency failure.
4. `pnpm --filter worker exec vitest run __tests__/low-worker-boot.test.ts`: RED expected fifth consumer but only four existed; GREEN24 cases with dedicated consumer/global cap and unchanged existing consumers.
5. `pnpm --filter worker exec vitest run __tests__/zalo-account-media-derivative.test.ts`: RED missing derivative module; GREEN actual sharp fixture proves original SHA unchanged, distinct preview path and bounded dimensions/output.
6. `pnpm --filter worker exec vitest run __tests__/zalo-account-media-maintenance.test.ts`: RED missing maintenance module; GREEN bounded dispatch, disabled writes, deletion outage, full candidate generation cleanup, referenced/leased skip and truthful HEAD outcomes.
7. `pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-media-purge.test.ts`: RED missing lifecycle helper; GREEN4 cases. Existing workspace lifecycle suite gained a case proving unconfirmed private objects stop parent/message deletion.

## Final focused verification

- Worker6 files97 tests PASS:

```sh
VITEST_MAX_WORKERS=1 pnpm --filter worker exec vitest run \
  __tests__/zalo-account-media-handler.test.ts \
  __tests__/zalo-account-media-downloader.test.ts \
  __tests__/zalo-account-media-network.test.ts \
  __tests__/zalo-account-media-derivative.test.ts \
  __tests__/zalo-account-media-maintenance.test.ts \
  __tests__/low-worker-boot.test.ts \
  --coverage '--coverage.include=src/zalo-account-media/*.ts'
```

Coverage at the unchanged80% global threshold: statements88.82%, branches83.27%, functions88.09%, lines88.98%. An earlier coverage run failed76.25/66.05/64.86/77.28%; meaningful magic, timeout, redirects, abort-late-stream and scavenger tests were added to reach the passing result. No threshold bypass.

- Queue2 files4 tests PASS: `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/worker-config exec vitest run __tests__/zalo-account-media-queue.test.ts __tests__/zalo-account-media-admission.test.ts`.
- Business lifecycle2 files13 tests PASS: `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-media-purge.test.ts src/workspace-lifecycle/__tests__/service.test.ts`.
- `pnpm --filter @chatbotx.io/worker-config check-types` PASS before later compatible additions.
- Worker typecheck was run sequentially; last completed pass attempt reported only the root-owned received-message metadata narrowing, subsequently reported fixed by root. Root owns final whole-worktree lint/type gates to avoid concurrent heavy tsc.
- Targeted `pnpm exec ultracite fix <25 owned files>` PASS; no commits/staging, migrations or live calls.

## Explicit remaining operational boundaries

- A process that crashes or is suspended after a PUT intent can have an unknown remote outcome. Positive HEAD proof now safely adopts an exact namespace/key/SHA/size/MIME-verified object by token CAS and projects it. All other such manifests stay fenced; neither HEAD404 nor a DB/storage outage is treated as proof no late PUT can occur. `recoverUnstarted` resumes only claims with no PUT intent. Automatic settlement of unknown remote writes requires an independently established quiescence protocol; this is not silently reported recovered.
- The worker reconciliation helper performs bounded, scoped DB-to-object HEAD diagnostics. Public backfill and prefix LIST/orphan decisions belong to the business/API agent; this report does not claim their acceptance coverage.
- Unit tests verify concurrency configuration and concurrent producer admission. No real two-replica Redis/provider/storage staging test, representative shard test, or DB EXPLAIN was run. These remain feature-enable gates.
- Full aggregate lint/type/integration checks are controlled by root. The default-off storage flag is retained.

## Review corrections — second RED/GREEN pass

- New handler/maintenance tests initially failed10 cases: positive object crash recovery and projection recovery did not exist, projection failure after stored completion was ignored, and definite PUT400/403 rejection retained uncertainty. Added `recoverZaloAccountMediaCandidates` (max50, shared15s HEAD deadline), verified namespace/key-embedded SHA/metadata SHA/positive safe integer role cap/MIME before `adoptVerifiedCandidate`, and independent `recoverZaloAccountMediaProjections` over50 due assets. Candidate absence, mismatched SHA/size/MIME and storage failures never adopt or delete.
- Handler invokes `applyStoredProjection` after transfer try/catch/finally. Projection failure can fail its queue job while stored bytes remain stored and pending projection remains recoverable; it never calls transfer `fail` after successful completion. Definite PUT400/403 rejection settles the lease as a terminal storage rejection; network, abort and5xx outcomes remain uncertain.
- New orphan tests initially failed3 cases because the worker stage was absent. Added bounded per-asset first/second-observation orphan admission and delete retry. It never calls account close/releaseOwners or pages an entire account. Already-closing/deleting orphan rows are retried after storage failure. Account deletion still follows its explicit account sentinel independently.
- Existing recovery scheduler uses a shared40s work deadline, with15s maximum candidate HEAD phase. It then drives account deletion, specific orphan cleanup, pending projections and due dispatch. Uploader abort signals reach all GET/PUT/HEAD/DELETE calls; no absence/outage becomes deletion proof.
- Final focused worker coverage command above passed97 tests with all unchanged80% global thresholds met. Targeted Ultracite passed. No live DB/network or migration execution.
