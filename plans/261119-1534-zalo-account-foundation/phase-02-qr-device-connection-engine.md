---
title: "Phase 2: QR-device connection engine"
status: todo
---

# Phase 2: QR-device connection engine

## Outcome

Extend the existing connection engine with a generic asynchronous
`qr_device` strategy. A connect session starts in `wait`, receives a short-lived
`show_qr` action, transitions after scan, and completes through the same
authorization/candidate/connection pipeline used by existing providers.

No Zalo SDK, queue, socket, or gateway import may enter this package or the builder.

## Requirements

- [x] `ConnectionStrategy` gains `qr_device` as an additive discriminant with
  mutually exclusive handlers; existing strategy narrowing remains exhaustive.
- [x] `ConnectSessionNextAction` gains
  `{ type: "show_qr", imageDataUrl, expiresAt }` with a data-image-only URL and
  ISO timestamp validation.
- [x] Starting QR auth does not resolve OAuth platform credentials and creates
  the session before invoking the provider start handler.
- [x] If provider start fails, the session becomes terminal and exposes only a
  safe provider error.
- [x] Trusted QR events are workspace/session/provider scoped. Events arriving
  after expiry, cancellation, completion, or replacement are no-ops/errors and
  cannot revive the session.
- [x] Scan and all terminal transitions clear the QR image from `nextAction`.
- [x] Verified auth is encrypted using the existing connect-session AAD and then
  follows existing candidate/target completion; no new auth table/state machine.
- [x] Public API session reads can return `show_qr`; there is no public endpoint
  for publishing gateway events.

## Files

### Modify

- `packages/sdk/src/lib/connection.ts` — `qr_device` provider strategy contract.
- `packages/utils/src/connection.ts` — `show_qr` schema and helpers.
- `packages/utils/__tests__/connection.test.ts` — action validation tests.
- `packages/connections/src/connect-session-flow.ts` — start/advance QR flow.
- `packages/connections/src/service.ts` and `src/index.ts` — supported service surface.
- `packages/connections/__tests__/connect-session-start.test.ts` — start behavior.
- `packages/connections/__tests__/service.test.ts` — state transitions and failures.
- `packages/connections/__tests__/integration/connect-session-flow.test.ts` — end-to-end fake provider flow.
- `apps/builder/src/features/connections/lib/connect-flow.ts` — strategy branch.
- `apps/builder/src/features/connections/schema/resource.ts` — public response schema.
- `apps/builder/src/features/connections/api/public.ts` — OpenAPI description/examples.
- `apps/builder/__tests__/connect-flow.test.ts` — no-OAuth credential resolution.

### Create only if the existing file exceeds the project size limit

- `packages/connections/src/device-session-flow.ts` — QR-specific orchestration;
  otherwise keep the small branch next to the existing session flow.

## Tests Before

1. Add a failing `show_qr` parser test: valid PNG/JPEG/WebP data URL passes;
   `http:`, SVG, arbitrary data URLs, invalid dates, and oversized payloads fail.
2. Add a fake `qr_device` provider test proving session creation precedes the
   start callback and begins with `{type: "wait"}`.
3. Add failing transition tests for generated → scanned → authorization and for
   QR expired/provider failed/session expired/cancelled.
4. Add replay/race tests: stale QR after scan cannot restore the image; duplicate
   auth completion is idempotent; wrong workspace/provider/session is rejected.
5. Add builder tests proving QR start never calls `resolveOAuthCredential` and
   existing OAuth/credential/self-serve branches are unchanged.

## Implementation Steps

1. Extend the SDK/provider discriminated union and the shared Zod action schema.
   Cap QR payload size at the API boundary to prevent oversized JSONB/API responses.
2. Add `startDeviceSession`: create a normal pending `ConnectSession` with
   `wait`, then invoke the provider's asynchronous start handler with opaque
   session/workspace identifiers. Fail the session if dispatch fails.
3. Add trusted service methods to publish a QR action, mark it scanned, attach
   verified authorization, and fail/requires-new-QR. Reuse existing encrypted
   authorization and candidate completion helpers.
4. Make every update conditional on workspace, provider, active status, and
   unexpired deadline. Clear `nextAction` on scanned/terminal paths.
5. Branch `startConnect`/`startReconnect` on `qr_device` before OAuth credential
   resolution. Reconnect retains and validates `targetConnectionId` ownership.
6. Expose the new action in public/private response schemas and OpenAPI only.
   The event-ingress route/consumer is deliberately deferred to item 5.
7. Run the repository's `cli-mcp-docs` workflow after the public API contract
   changes so CLI/MCP/docs representations remain agent-first and synchronized.

## Refactor

- Extract only the small shared “attach verified auth and continue” function
  needed by OAuth and QR; do not duplicate `completeAuthorization` wholesale.
- Keep `ConnectSessionService` registry-free. Provider registry lookup and
  handler invocation stay in `@chatbotx.io/connections`.

## Tests After

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/utils exec vitest run __tests__/connection.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/connections exec vitest run __tests__/connect-session-start.test.ts __tests__/service.test.ts __tests__/integration/connect-session-flow.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/connect-flow.test.ts
pnpm --filter @chatbotx.io/utils check-types
pnpm --filter @chatbotx.io/connections check-types
pnpm --filter builder check-types
```

Regression gate: run the complete `@chatbotx.io/connections` suite because the
provider union and shared completion pipeline are public contracts.

## Acceptance Criteria

- [x] A fake QR provider completes a connection without OAuth credentials.
- [x] QR data is short-lived, bounded, workspace-scoped, and cleared after use.
- [x] Existing provider strategies retain their exact behavior and response shapes.
- [x] No `zca-js` or Node-only gateway code appears in builder imports.
- [x] The only unfinished seam is the item-5 transport that calls the trusted methods.

## Risks and rollback

- Risk: async start succeeds after DB failure or vice versa. Creating the DB
  session first gives the gateway a valid id; dispatch failure terminates it.
- Risk: stale events overwrite a newer action. Conditional active-state updates,
  gateway epoch, and fresh-session retry prevent revival.
- Rollback: remove the union/action/branch; existing stored sessions never use
  `show_qr` while `zaloAccount` remains unregistered.
