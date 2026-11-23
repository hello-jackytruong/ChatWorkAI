# Phase 3 builder UI/API evidence

Date: 2026-11-23. Scoped follow-up on the existing Phase 3 implementation.

- Status-only superAdmin action calls the shared status service and never lists groups. Existing full operations action still returns `{ status, groups }` for group configuration. Positive and denied-permission tests cover both boundaries.
- Manage rows use the separate status query; group queries mount only while configuration is open. One settings-level workspace subscription coalesces IDs for 250 ms, bounded to 100 mounted accounts. Hidden hints mark caches stale with no refetch; visibility is checked again when the timer fires. Closed group panels invalidate cached operations without fetching groups. Existing polling pauses while hidden.
- Disconnect cancels both in-flight status/operations queries before replacing their cached status. Regression resolves an older connected request after successful disconnect and confirms it cannot overwrite the disconnected/socket-closed cache.
- Existing channels-scoped GET status route now documents optional verified runtime and unknown socket state. Public handler continues to call the same workspace-scoped service. Output tests cover additive runtime, null, absent legacy runtime, and strict rejection of internal owner/fence/epoch/attempt/sequence, raw error, QR and cookie fields inside runtime.
- Existing UI retains safe runtime details in the configuration dialog, translated terminal QR labels and status badge truth separation. No new API operation, socket, row timer, Node-only router dependency, migration or change to another channel.

## TDD and validation

- New public-description assertion first failed because existing metadata omitted the optional verified runtime semantics (1 failed / 10 passed); updating that existing route description made it pass. Remaining additions characterize and protect behavior already implemented in this session.
- Focused Zalo builder set: seven files, **42 tests passed**, using `VITEST_MAX_WORKERS=1` (includes six status-query resource/visibility/realtime tests).
- Scoped Biome: **30 files checked, no errors**.
- Builder `i18n:check`: **no missing keys or invalid translations**.
- Full lint, builder typecheck and coverage are owned by the controller and were not run in this follow-up to avoid concurrent memory pressure. No claim that those final gates have completed.
