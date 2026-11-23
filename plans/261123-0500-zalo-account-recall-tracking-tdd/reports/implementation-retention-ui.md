# Retention state and realtime implementation

2026-11-23, isolated checkout `zalo-account-recall-tracking`.

Only owned changes: `features/messages/lib/zalo-retention.ts`, `features/chat/store/chat-store.ts`, `features/chat/chat-realtime.tsx`, and `__tests__/zalo-account-retention-store.test.ts`.

The store now normalizes Zalo lifecycle metadata at its existing state-write seam, including seeded initial state, older page merges, duplicate realtime rows, text/attachment edits and translation updates. Recalled/local-hidden state is monotone across late updates; ordinary data uses the shared pure projector. Provider delete-only-me remains separate and does not hide CRM content. Non-Zalo replacement/edit behavior remains unchanged. One linear pass across loaded timeline, previews and reply selection avoids per-conversation history scans.

Off-page parent lifecycle events use the event's safe `zaloAccount.sourceId` to scrub embedded quote copies in loaded messages, keeping normal reply body/attachments. A safe retained-quote marker carries that fence across later attribute/page/echo replacements. No original content is stored in the fence and no all-history cache is added.

Realtime lifecycle events invalidate the existing Zalo tracking key and saved-content query for the exact message under its workspace prefix, then invoke the existing throttled conversation-head refresh. No polling or new timer/worker.

TDD: initial four tests produced three behavioral RED failures (raw original/translation restoration, off-page quote leak, stale-page restoration), with non-Zalo characterization already green. A later duplicate-page marker test exposed another RED, fixed by applying page lifecycle fences before deduplication. Final focused regression command:

`VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-account-retention-store.test.ts __tests__/chat-store.test.ts __tests__/chat-realtime.test.tsx __tests__/translation/chat-store-translation.test.ts`

Result: **4 files / 165 tests PASS** (9 new tests). Scoped Ultracite over all four owned files PASS. Builder typecheck remains controller-owned; no tsc started in this slice. No UI layout/component/API/i18n files changed, no background process left, no commit.

Controller builder typecheck initially found that Drizzle's public `Json` content-attributes type includes scalars/arrays, while the helper's generic bound assumed objects. Corrected the helper input to `unknown` and narrowed through its existing object parser; actual message resource types now remain inferred throughout the merge, removing array/reply casts. Added an explicit event-presence guard and reused the existing realtime payload cast before reading a message-created frame. These are type-boundary corrections; scoped formatter passed. Controller will rerun builder types after its sequential business gate; no local tsc or broad test started during that slot.

## Sparse conversation regression repair

The controller's full suite exposed a real non-Zalo regression: sparse conversation fixtures do not have a `messages` preview array, and the new normalizer's `flatMap` emitted `undefined` into the row list. Reproduced before fixing: `thread-control-view.test.ts` RED **5 failed / 27 passed**, stack at `identity(row).workspaceId` through `retainChatState` while patching WhatsApp thread control. The owning thread-control feature and fixtures were unchanged.

Fixed the normalizer and its new ZA detection path to treat absent preview arrays as empty; conversation reconstruction skips absent/empty previews and preserves the existing conversation object. Existing preview patch helpers also skip absent preview arrays. Final narrow regression run: `thread-control-view`, retention-store, chat-store, chat-realtime, and translation-store: **5 files / 197 PASS**. Scoped formatter PASS; no tsc or additional broad suite started.
