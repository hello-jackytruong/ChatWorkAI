# UI regression tests and localization

Status: DONE

## Scope

Read builder-ui-i18n skill and existing React test conventions. Owned only the two new builder UI test files and all 21 locale JSON files. Component fixes and public API integration remain owned by the parent.

Added 31 `zaloAccount` keys consistently across all 21 locales, with English/Vietnamese copy and localized Arabic, Azerbaijani, Danish, German, Spanish, Finnish, French, Hebrew, Indonesian, Italian, Japanese, Dutch, Portuguese (Brazil/Portugal), Romanian, Swedish, Turkish and Simplified/Traditional Chinese copy. Existing keys and values are preserved. Copy distinguishes local hide, provider recall, delete-for-me, retained originals, capture absence, denial, unconfirmed outcomes, explicit chat boundary and history retention.

## Meaningful UI verification

Both files mount actual components and actual TanStack Query hooks under a fresh QueryClient for each test; only server actions, translations and dialog presentation wrappers are mocked. No QueryClient singleton is shared between tests.

Saved-content dialog (6 tests):

- No original request before review is opened.
- Permission denial renders no retained original or attachment link request.
- Original not captured is distinct from denied.
- Only an explicitly selected stored attachment issues a URL; remote and missing files have no download action.
- Closing removes the original query cache; reopening calls the server again and respects a new denial.
- Changing the exact timestamp tuple clears both original query state and previously issued signed links.

Native actions (7 tests):

- Capabilities fetch only after expanding actions; originals fetch only after explicit review.
- Disabled native gate leaves native controls disabled while local hide remains available.
- Unknown stays unconfirmed; confirmation disappears and status inspection never resends.
- Only applied results render success; explicit failure remains distinct from unknown.
- DeleteChat requires explicit confirmation and submits the exact selected boundary.
- Rerendering the wrapper with a newer sidebar message cannot widen an open deletion boundary.
- Disabled boundary capability prevents native chat deletion.

## RED evidence and source fix

The exact-tuple test initially failed: changing `createdAt` while retaining the same message ID left the old signed attachment link rendered because the SavedContent React key omitted timestamp. Reported to parent; parent included the timestamp in the component key. The unchanged test then passed. Parent also added explicit failed-status handling and caught status-inspection rejection.

## Checks

- `VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-account-saved-content-dialog.test.tsx __tests__/zalo-account-native-actions-ui.test.tsx` — 2 files, 13 tests passed.
- `pnpm --filter builder i18n:check` — no missing keys or invalid translations.
- Scoped Ultracite formatting/checks — passed for owned tests.

No tsc was started; parent owns sequential combined type checks. No browser/dev server, real provider call, migration, or commit was performed.
