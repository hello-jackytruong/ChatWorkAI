# Plan review and validation record

Date: 2026-11-23. Scope: plan authoring only; implementation remains pending.
Reviewers: failure modes; security; assumptions/scope. Four phases, standard verification (fact/contract checks); no live calls, lint/build/tests executed during review.

## Evidence-backed findings and disposition

| # | Finding | Severity | Source evidence | Disposition / required propagation |
|---|---|---|---|---|
| 1 | Main-DB alias can roll back after destructive shard echo merge | High | `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:146,186`; `apps/worker/src/chat/handlers/send-message.ts:1393`; `packages/database/src/sharding/message/repository/sharded-message-repository.ts:953` | Accept. Commit durable identity/rebind intent before destructive workflows at both entry points; crash test after shard commit/before main commit. Phase2. |
| 2 | DB lease fencing cannot stop a remote late PUT | High | `packages/filesystem/src/lib/uploader.ts:76` | Accept. Closing barrier + durable manifest; parent purge remains incomplete while old writes/outcome uncertain; compensate after late write, never cascade away manifest. Phases1/4. |
| 3 | Fair dispatch does not defeat strict-priority execution starvation | Medium | `packages/worker-config/src/queues/heavy/index.ts:112` | Accept. Outstanding backlog cap plus actual aged-job priority promotion; continuous-arrival test. Phases1/3. |
| 4 | Last-reference check races new shared-sticker registration | High | `packages/business/src/message-cleanup/service.ts:210` demonstrates separate DB/object steps | Accept. Registration/deletion claim serialize on asset lock; next generation for new ref during delete; network outside transaction and token-CAS finalization. Phases1/4. |
| 5 | UI hides deleted attachment but generic signer does not enforce recall visibility | High | `apps/builder/src/features/messages/components/message-item.tsx:319,372`; `packages/business/src/message/list-for-conversation.ts:23,79`; `apps/builder/src/lib/public-api/member-scope.ts:152` | Accept. New signing/projection explicitly checks parent existence/deletedAt, without creating recalled-content viewer; already-issued URLs expire normally. Phase3. |
| 6 | New descriptors would fail current inbound event envelopes/refinements | High | `packages/sdk/src/lib/zalo-account.ts:241,245,265`; `apps/zalo-account-gateway/src/runtime/provider-message.ts:171,251` | Accept. Update both inbound schemas and wire serialization; RED descriptor-only messages, outbound schema unchanged. Phase2. |
| 7 | Provider CDN allowlist cannot archive arbitrary successful API URL sends | High | `packages/business/src/zalo-account/canonical-send.service.ts:188` | Accept. Archive outgoing from trusted uploaded object, separate from provider URL fetch policy; do not narrow existing sending contract. Phases1/2. |
| 8 | API hook misses device/Inbox/media-library original capture | High | `packages/business/src/message/create-outgoing.ts:657,730,801` | Accept. Explicit Zalo-only registration/protection at createOutgoing seam; filesystem upload currently preserves bytes, no speculative rewrite. Phase2. |
| 9 | Friend/group hook misses account avatar on reconnect | Medium | `packages/business/src/zalo-account/service.ts:177`; `apps/worker/src/events/zalo-account/handler.ts:78`; `packages/connections/src/device-session-flow.ts:314`; `packages/business/src/connection/store-bindings-channels.ts:441` | Accept. Hook the live trusted authorization/profile-binding route (saveAuthorization alone has no production caller) and any explicit profile saves; absent source does not clear saved revision. Phase2. |
| 10 | Asset-only prefix did not implement requested physical conversation partition | Medium | `docs/zalo-account-checklist.md:50` | Accept. Add conversation segment for message objects, separate resource namespace for profile/sticker; bind before transfer. Phases1/2/3. |

All ten findings refine the requested storage scope; none changes a user-approved product decision or adds another feature. The controller incorporates them while authoring the proposed plan. No implementation approval is inferred.

## Verification approach

- Follow existing service/repository boundary; enumerate future files as Create and current owners as Modify.
- Verify current paths/test targets and source contract; do not treat proposed files/operations as existing.
- Check full24 item traceability, original checkbox snapshot, phase dependency acyclicity, RED/GREEN/REFACTOR and actual capped test commands.
- Check no broad Attachment/Message DDL, shared hydration/optimizer default change, new process, or history/native-operation scope.
- CLI structural validation is distinct from running implementation tests or proving provider/storage production behavior.

## Deployment checks that remain intentionally unrun

Private real bucket policy/anonymous access, provider/CDN fixtures for optional resource types, actual multi-worker queue budget, approved disposable DB schema tests, resource measurements and production migration/flag-on require the later implementation/release workflow. This document does not claim them passed.

## Whole-plan consistency sweep — final

- Re-read plan.md, all4 phase files and all5 report files (10 files total).
- Full24 checklist requirements mapped; original checklist checkbox snapshot remains unchanged. All28 implementation tasks pending.
- Checked16 local links and47 distinct existing absolute source paths;21 existing regression test paths independently verified. Proposed future files/operations are labeled as such.
- Reconciled all10 review deltas across contract, phases and coverage: inbound envelopes, all outgoing seams/trusted-storage source, live avatar binding, conversation object prefix, canonical aliases before destructive shard transactions, shared-generation deletion lock, late-PUT incomplete barrier, bounded queue aging, and deleted-parent signing.
- Additional consistency checks: source_missing is a reason not sixth storage state; deletionPhase is separate; no Node downloader exports into builder graph; single default-off media switch; no generic hydration/optimizer default, Message/Attachment DDL or existing public source lifecycle change.
- Source/path corrections, test command corrections and policy clarification did not change requested product scope; no user decision was reversed.
- `ak plan validate plans/261123-0500-zalo-account-media-r2-tdd --json`: valid true. This is structural/document validation, not implementation verification.
- Runtime task management discovery found no suitable session task surface;28 unchecked phase tasks remain the source of truth. No GitLab issue/chat/automation or active-plan pin was created.
- No unresolved internal plan contradiction found. Live fixture/private storage/resource/DB gates remain unrun release checks; they are not represented as completed tests.

## Validation questions

No additional product choice was required to author the requested storage plan. Numeric limits are explicitly proposed technical defaults; production activation, migration application and any later deviation require the applicable implementation/release decision, not inferred approval from this plan.
