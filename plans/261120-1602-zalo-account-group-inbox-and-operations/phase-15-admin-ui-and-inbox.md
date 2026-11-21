---
phase: 15
title: "Zalo Account admin UI and group Inbox presentation"
status: completed
priority: P1
effort: "L"
dependencies: ["Phase 14"]
---

# Phase 15: Zalo Account admin UI and group Inbox presentation

## Execution status

Implementation and static verification passed on 2026-11-21. Evidence: [progress](./reports/implementation-progress.md) and [review](./reports/implementation-review.md). Live provider/database/instance checks remain under Phase 16 and are not claimed as completed.

## Goal

Give operators a clear, translated control surface for account health/sync/group policy while rendering group conversations correctly in the existing Inbox.

## UI scope

### Settings

- Preserve QR connect, reconnect, and disconnect; show safe health, reconnect reason, gateway unavailable/degraded state, and the unofficial-account warning.
- Show friend/group/label last sync status, completeness/degraded state, counts, and explicit retry/reconcile actions.
- Account kill switch plus per-group receive/send switches and automation mode selector (`disabled`, `mentionOnly`, `all`); the action endpoints enforce `superAdmin`, not only the page layout.
- Group row shows name/avatar/member count/accessibility and why a control is disabled.
- Label sync/mutation status includes paused/conflict/uncertain outcome and recovery action.
- Replace `router.refresh()`-only mutation handling with dedicated TanStack Query invalidation or `setQueryData` for Zalo Account resources.

### Inbox

- Reuse the current conversation list/detail/message composer. Show group name/avatar/member count and a group badge without exposing the anchor as a customer profile.
- Inbound bubbles show actual sender name/UID fallback; mentions render from validated spans; self echoes remain outgoing.
- Reply preview validates same-group source; image/file messages use existing safe previews.
- Typing shows actor name and expires automatically; reactions/receipt aggregates/undo tombstones update from realtime.
- Customer-only actions hidden or disabled for `channelGroup`; tags remain available because Phase 12 explicitly supports them.
- Composer honors send policy/kill switch and shows structured policy/rate/reauth errors.

## Files to modify/create

- Zalo Account settings components/actions/query hooks/resource schemas under `apps/builder/src/features/zalo-accounts`.
- Conversation/message presentation in `apps/builder/src/features/conversations`, `features/messages`, `features/chat/chat-realtime.tsx`, and the workspace realtime provider only where group metadata changes rendering.
- The guest webchat realtime consumer and protocol compatibility tests to prove optional actor/audience/expiry fields do not alter its existing boolean typing behavior.
- Translation keys in `apps/builder/messages/en.json` and all locale files; reuse existing `fields.*`/actions keys first.
- Focused component/store tests in builder test locations.

## TDD sequence

### RED

1. Policy form binds workspace/account IDs, invalidates the group query, cannot enable controls for inaccessible/kill-switched groups, and rejects direct action invocation by a normal workspace member.
2. Health/sync/label error states render safe translated copy and never raw provider/auth data.
3. Group conversation list/detail shows group metadata while customer-only buttons are absent.
4. Two member messages show two sender labels inside one conversation.
5. Mention/reply/image/file rendering and self-echo direction match stored attributes.
6. Typing filters by conversation and expires; direct and guest typing remain compatible; reaction/receipt/undo realtime updates are idempotent.
7. Composer blocks disabled/rate-limited/reauth states and preserves unsent input.
8. Locale parity and RTL logical-property checks pass.

### GREEN

1. Add typed query options/invalidation for account/group/status resources.
2. Extend settings with compact operational controls and translated warnings/errors.
3. Add narrow group-content parsers/components near message rendering; keep generic message components unaware of raw provider payloads.
4. Extend chat realtime/store handlers for actor typing, receipt/reaction content updates, and tombstones.
5. Gate customer-only actions by the safe conversation/contact resource discriminator.
6. Update all locale files and applicable accessibility labels/keyboard behavior.

### REFACTOR

- Keep settings and Inbox concerns separate; do not embed message history in the settings group table.
- Reuse shared UI primitives and existing message/realtime stores.

## Focused verification order

```bash
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-accounts-ui.test.tsx
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run src/features/messages/components/__tests__/zalo-account-group-message.test.tsx
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run src/features/chat/store/__tests__/chat-store.test.ts
pnpm --filter builder i18n:check
```

## Success criteria

- [x] Operators can understand and control account/group receive/send/automation without hidden defaults.
- [x] Group Inbox displays real sender/mentions/lifecycle state and never looks like a customer contact.
- [x] Query caches update after every mutation; all user-facing strings are translated.
- [x] QR/direct-message UI remains unchanged outside shared safe projections.

## Rollback

Hide group-specific settings/Inbox decorations behind the account kill switch while preserving stored messages and direct channel UI.
