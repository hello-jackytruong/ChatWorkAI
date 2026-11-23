# Hostile plan review — Security Adversary + Contract Verifier

Date: 2026-11-23. Standard-tier, read-only plan/source review. No lint, build, typecheck, tests, migrations or provider calls. Scope held at R01–R16; this review does not propose cuts. Phase 3 was read after its full draft became available; temporary stubs were not counted as defects.

## Findings raised for correction

### High — translated content can reappear after an early safe projection

Plan phase 2:70 requires redaction before attachment signing, including translated text, but does not yet state how to handle later enrichment. Actual private list/detail code applies `withMessageTranslations` **after** `messageService` returns (`apps/builder/src/features/messages/queries/index.ts:52-55,74-78`); public detail also enriches afterward (`features/messages/api/public.ts:208-212`). A safe business-level Message could acquire original/translated text again at this layer.

Minimal fix: keep early pre-sign projection, then skip translation enrichment for retained ZA or reapply safe projector after enrichment. Add `queries/index.ts` to the file inventory and RED fixtures with original sentinel strings only in translations, exercising private list/get and public list/get. Do not alter translation behavior of non-ZA messages.

### High — gateway authorization must be first-winner durable CAS, not matching an existing claim

Plan phase 2:45 says pending→dispatched commit then gateway confirms claim, while phase 3:99 requires CAS after Redis TTL. Those requirements need one unambiguous actor/protocol. Existing gateway dedupe uses Redis 24h (`apps/zalo-account-gateway/src/transport/command-executor.ts:112,132-138`); backing claim expires (`redis-command-state-store.ts:12-20`) and complete overwrites without compare-and-set (`:33-43`). A replay after TTL can pass matching fence validation and repeat an SDK call unless the gateway is the sole first acquirer of durable dispatch permission.

Minimal fix: builder/business prepares pending only. Gateway executes main-DB conditional `pending→dispatched` CAS for immutable attempt id+hash+target+active fence. Only a newly won CAS return authorizes one SDK invocation; already dispatched/unknown/applied/failed returns inspect-only, including same fence. Completion CAS checks immutable claim id and permissible prior status. Crash after claim is unknown, never reclaimable. RED: fresh Redis claim after Redis eviction/24h, redelivery with same active fence, and concurrent executor calls still total one provider invocation. No new queue or multipurpose send-attempt ledger needed.

### High — quote references must be projected for otherwise normal reply rows

Plan phase 2:70's own-message marker condition plus recursive projection is insufficiently explicit. An unmarked normal reply embeds another message's original in direct `contentAttributes.zaloAccount.quote` (`integrations/zalo-account/src/message.ts:158-166`); quote schema contains providerMessageId+text (`packages/sdk/src/lib/zalo-account.ts:216-224`). Group payload has corresponding quote copy. Recalled parent may be outside the response page, so neither row marker nor page-local lookup proves quote safety. Phase 3:20 handles loaded visible replies but cannot fix server API responses alone.

Minimal fix: extract bounded explicit quote target refs from **all returned ZA rows**, batch ledger lookup with complete workspace/account/thread/provider identity, and replace quote content when referenced target retained. Preserve reply body and state. Parent-not-in-page DM/group RED tests must inspect serialized DTO and late realtime/page merges. No history scan or bulk DB rewriting.

### Medium — sidebar/conversation API bypass owner absent from initial file inventory

Plan phase 2:70-71 correctly promises safe sidebar/preview projection, but initial inventory omits `apps/builder/src/features/conversations/queries/list-conversations.query.ts`. It reads repository directly (`:180-202,285-303`) and returns raw last Message in compact (`:243`), full (`:265`) and detail (`:316`) responses. Updating `messageService`/`list-for-conversation.ts` will not reach these paths; merely changing the visual label in `resolve-last-message-preview` leaves API originals exposed.

Minimal fix: explicitly wire batch projection into that query owner before all three response branches and cover public/private GET/POST list, compact/full, and detail. Existing conversation API handlers consume this shared owner (`features/conversations/api/public.ts:173-196`, private `:52,71,88`). Do not change other channels' raw DTO contracts.

### Low — factual inventory defects

- Initial phase 2:111 names `src/lib/public-api/authorize-workspace-access.ts`; verified owner is `apps/builder/src/lib/workspace/authorize-workspace-access.ts:215-244`. Replace path now rather than asking implementer to discover it again.
- Initial phase 2:124 marks nonexistent gateway `__tests__/zca-client.test.ts` Modify; it is Create.
- Initial phase 3:21,37 says 20 locales/19 siblings, but `apps/builder/messages/` has **21** current files. Enumerate all 20 siblings of en; do not depend on stale skill count.

## Verified acceptable decisions / non-findings

- Same conversation read ACL, no new permission bit: phase 2:18 resolves actual assigned/team scope for sessions/mobile, workspace-level token semantics, and complete account/thread/message ownership. This is consistent with `lib/public-api/member-scope.ts:21-26,152-163`. New review is not protected merely by weaker old private membership reads.
- `inbox` token scope for these resources is explicit at phase 2:52 and T26. Read-only token mutations rejected by real middleware, owner-expiry-only exact POST exceptions kept separate (phase 2:66). Source separates permission gate (`middlewares/workspace-token-auth.ts:250-264`) from owner quota gate (`:266-272`); scheduled deletion still separately denied in auth middleware. No global POST widening requested.
- Provider SDK ownership/arguments: phase 2:43,46 is explicit server-derived refs; `deleteMessage(...,true)`, separate undo, immutable deleteChat boundary. SDK deleteMessage rejects DM everyone-delete and own everyone-delete (`zca-js/dist/apis/deleteMessage.js:17-24`); deleteChat sets onlyMe=1 (`deleteChat.js:22-37`). Group global moderation remains out of scope, without dropping requested native operations.
- Native gate default off and controlled disposable proof are correctly required (phase 2:42,161-165). Static signatures/mocks are not mislabeled provider proof. Unknown does not auto-replay, native attempt metadata survives Redis TTL.
- Existing generic Zalo delete guard remains (`delete-message.action.ts:50-54`), shared cascading delete remains characterized. Recall exact mutation keeps replies and receipt/reaction history; 90-day receipt retention accepted, not silently expanded into event sourcing.
- Media boundary is scoped and honest: phase 2:72-73 stored-only existence check once on request, no new hydration or unauthenticated fallback. Existing media token proxy (`app/media/media-proxy.ts:48-85`) authenticates bearer capability/workspace, not current member assignment; new saved endpoint must not use it as ACL replacement. Existing previously issued storage URLs/cache are not retroactively revocable; plan explicitly acknowledges this. No new media platform proposed.
- Audit is best effort view/link-issued metadata, no body/URL/credentials, no actual byte-download guarantee (phase 2:73). This matches swallowed queue errors in `packages/business/src/audit/service.ts:40-68`; stronger fail-closed audit would be new scope.
- Original modal state is ephemeral and reauthorized on open/download, close/account/workspace/ACL-change clearing and late-response cancellation required (phase 3:17-20). Prior saved/downloaded user copies are not claimed revocable.
- Additive metadata schema only, purge boundary explicit, no auto migration apply; full R01–R16 retained. Budgeted recovery/locator, no new daemon or infinite fanout. Those are relevant safety constraints, not reasons to trim requirements.

## Resolution tracking

Controller has accepted the sidebar/quote/CAS/inventory corrections and assigned them to the active plan writer. They were communicated during drafting. Status below is updated after the writer's changes become visible; findings refer to the initial reviewed lines and must not be mistaken for implemented source defects.

Latest reread confirms fixed in plan:

- Gateway first-winner CAS and same-fence redelivery after Redis 24h: phase 2:45 now explicit.
- All ZA quote references, including parent outside page, bounded page+quote target batch lookup: phase 2:70 now explicit.
- Sidebar owner added: phase 2:111.
- Authoritative expiry helper corrected: phase 2:115.
- Locale inventory corrected to 21 total/20 siblings: phase 3:21,38.

Subsequent reread also confirms translation enrichment ordering fixed at phase 2:72, owning `queries/index.ts` added at :113, translation sentinel RED at :133. All substantive security findings are resolved in the plan. One low inventory defect remains: absent gateway zca-client test still marked Modify at phase 2:130; change to Create. This was sent to controller and requires no source changes in this plan-only task.

Status: DONE_WITH_CONCERNS
Summary: Full plan read; substantive projection and replay findings corrected in the plan and verified by rereading. No implementation or runtime validation performed.
Concerns: One low test inventory label remains (Modify→Create). Native live proof and signed-link lifetime remain explicit delivery limitations.
