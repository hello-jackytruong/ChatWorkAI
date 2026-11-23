# Focused UI simplification

Status: DONE

Reviewed the two assigned, newly implemented components and their existing 13 UI test cases. Read the builder UI/i18n and testing-workflow skills, project guidance, Zalo Account documentation, and the bundled Next.js client-component guidance before editing. The CodeGraph CLI was unavailable, so source inspection used direct reads after the attempted CodeGraph lookup.

## Changes

- `apps/builder/src/features/messages/components/zalo-account-message-actions.tsx`: extracted the confirmation and inspection workflows into named local callbacks, removing long asynchronous handler bodies from nested JSX.
- `apps/builder/src/features/messages/components/zalo-account-saved-content-dialog.tsx`: extracted attachment download into a named local callback, keeping the attachment row rendering easier to scan.

The callbacks preserve the existing action arguments, state-update order, confirmation boundary, command IDs, result labels, error handling, and sequential query invalidation. The lazy original read, exact-tuple component key, component-local signed URLs, and translation keys remain intact. No new abstraction, dependency, or test was needed.

## Validation

- PASS: `pnpm exec ultracite check apps/builder/src/features/messages/components/zalo-account-message-actions.tsx apps/builder/src/features/messages/components/zalo-account-saved-content-dialog.tsx` — 2 files, no fixes.
- PASS: `VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-account-native-actions-ui.test.tsx __tests__/zalo-account-saved-content-dialog.test.tsx` — 2 test files, 13 tests.
- Full repository lint and builder typecheck belong to the parent session's final verification gate. No typecheck process was started in this subtask, as requested.

Concerns/Blockers: none within the assigned scope.
