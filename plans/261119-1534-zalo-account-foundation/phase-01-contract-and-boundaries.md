---
title: "Phase 1: Contract and boundaries"
status: todo
---

# Phase 1: Contract and boundaries

## Outcome

Freeze the names, auth schema, QR/runtime events, security boundary, and explicit
non-goals before any shared connection or runtime code changes. Reserve
`zaloAccount` as a provider identifier while keeping it inert and unavailable
to users until the later channel-registration item.

## Context

- `packages/database/src/partials/integration.ts` owns `IntegrationType`.
- `packages/sdk/src/lib/auth/index.ts` supports provider-specific
  `authType: "custom"` data but only performs the generic envelope validation.
- Existing `zalo` is Zalo OA and has a different auth/runtime model.
- Reference behavior: QR generated/expired/scanned/login-info and verified
  `getOwnId()` in `ZaloCRM/backend/src/modules/zalo/zalo-pool.ts`.

## Requirements

- [x] Provider id is exactly `zaloAccount`; `zalo` remains untouched.
- [x] Provider-specific auth schema requires `cookie`, non-empty `imei`,
  non-empty `userAgent`, and verified non-empty `zaloUid` under
  `authType: "custom"`.
- [x] Cookie validation accepts the pinned SDK's non-empty serialized cookie
  array (`{ key, value }[]`) but rejects strings, nulls, maps, and empty arrays;
  do not use `unknown` as the final validation boundary.
- [x] Public/runtime event schemas contain only the minimum fields needed by
  later phases and classify secret-bearing events separately.
- [x] `zaloAccount` is present as an explicit `null` in the exhaustive
  connection registry so it cannot be started before the later registration phase.
- [x] Document that personal-account automation uses an unofficial API and may
  require operational/legal review; do not present it as Zalo OA support.

## Files

### Create

- `packages/sdk/src/lib/zalo-account.ts` — provider auth and gateway event schemas.
- `packages/sdk/__tests__/zalo-account.test.ts` — contract tests.
- `docs/zalo-account.md` — architecture boundary, risk, and later integration seams.

### Modify

- `packages/sdk/src/index.ts` — export the provider contract.
- `packages/database/src/partials/integration.ts` — reserve `zaloAccount`.
- `packages/connections/src/registry.ts` — exhaustive inert `zaloAccount: null`.
- `packages/connections/__tests__/registry.test.ts` — prove it is unavailable.
- Every exhaustive `Record<IntegrationType, ...>` found by
  `rg 'Record<IntegrationType'` — add the narrow inert/unsupported entry required
  by that owner; do not pretend Zalo Account supports a legacy fetcher/cleanup path.

## Tests Before

1. Add failing SDK tests for valid structured credentials and each malformed
   field, including an auth payload missing the verified UID.
2. Add failing event-schema tests for QR generated, QR scanned, credentials
   obtained, connected, closed, and reauthorization-required events.
3. Add a registry test proving the reserved provider resolves to no adapter and
   cannot enter `startConnect`.
4. Run the focused tests and record that they fail because the provider schemas
   and enum member do not exist yet.

## Implementation Steps

1. Define `ZaloAccountAuth` as a strict provider schema layered on the generic
   custom-auth envelope. Keep credentials and display/profile metadata separate.
2. Define discriminated runtime events. Only the credential event may carry
   secret fields; logging helpers must receive a redacted event type.
3. Add `zaloAccount` to `IntegrationType` and immediately satisfy the exhaustive
   registry with `null`. Do not add `ChannelType`, integration package, picker,
   store binding, or connection adapter here.
4. Document invariants, unsupported API risk, secret classification, and the
   division between durable state (`Connection`/DB) and ephemeral runtime state
   (gateway/Redis).
5. Run the `IntegrationType` cascade search and compile affected workspaces;
   partial maps need no entry, while exhaustive maps must state unsupported
   behavior explicitly.

## Refactor

- Keep schemas in the SDK package so the connection engine, business layer, and
  gateway share one contract; do not duplicate Zod objects in each app.
- Do not generalize non-Zalo event names beyond what Phase 2 needs for
  `qr_device`; provider-specific socket events remain Zalo-specific.

## Tests After

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/sdk exec vitest run __tests__/zalo-account.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/registry.test.ts
pnpm --filter @chatbotx.io/sdk check-types
pnpm --filter @chatbotx.io/connections check-types
```

Regression gate: the full SDK and connections suites remain green and every
`Record<IntegrationType, ...>` compile site is handled explicitly.

## Acceptance Criteria

- [x] All downstream phases can import one canonical auth/event contract.
- [x] Malformed or incomplete session credentials fail before encryption or DB writes.
- [x] `zaloAccount` cannot be connected through public/private APIs yet.
- [x] No existing `zalo` behavior or type changes.

## Risks and rollback

- Risk: reserving an `IntegrationType` causes exhaustive maps to fail. Mitigate
  by searching `Record<IntegrationType` and fixing only required inert entries.
- Rollback: remove the enum/export/null registry entry and docs; no persisted
  rows or user-visible behavior exists in this phase.
