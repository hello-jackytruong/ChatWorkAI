# Evidence inventory — P0.1

Source checked on 2026-11-23; line references are investigation anchors, not a promise that future line numbers stay fixed. Workspace root: `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`.

| Claim checked | Evidence | Planning consequence |
|---|---|---|
| Runtime marks connected immediately after start | `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:476` | RED test must separate start from actual open event. |
| Adapter drops numeric close code | `apps/zalo-account-gateway/src/runtime/zca-client.ts:77` | Carry normalized code and safe reason to runtime. |
| SDK retry disabled already | `apps/zalo-account-gateway/src/runtime/zca-client.ts:183` | Keep one reconnect owner in runtime. |
| Per-runtime generation exists | `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:60` | Add per-socket attempt invalidation without replacing ownership lease. |
| Passive close shares runtime generation on retry | `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:482` | Late callbacks from old socket need their own attempt fence. |
| Detached errors swallowed | `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:712` | Classify transport/publish/provider errors separately; log safe summary. |
| Existing cleanup path | `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:640` | Extend cleanup, avoid competing lifecycle implementations. |
| QR SDK has decline and abort callbacks | `apps/zalo-account-gateway/node_modules/zca-js/dist/apis/loginQR.d.ts:3` | Explicit decline/cancel/timeout and SDK abort tests. |
| QR adapter handles GotLoginInfo | `apps/zalo-account-gateway/src/runtime/zca-client.ts:317` | Keep auth on encrypted event route only. |
| Client initialized with local Zalo instance | `apps/zalo-account-gateway/src/runtime/zca-client.ts:335` | Scope request abort wrapper to client/operation; no global fetch patch. |
| SDK accepts fetch polyfill | `apps/zalo-account-gateway/node_modules/zca-js/dist/context.d.ts:146` | Can investigate bounded abortable login requests without SDK upgrade. |
| SDK calls configured fetch | `apps/zalo-account-gateway/node_modules/zca-js/dist/utils.js:265` | Tests must prove abort reaches actual request, not just Promise.race. |
| SDK getCookie returns cookie jar | `apps/zalo-account-gateway/node_modules/zca-js/dist/apis/getCookie.js:6` | Serialize/validate cookie list; never forward context or stringify entire jar/context into public metadata. |
| SDK getContext returns whole context | `apps/zalo-account-gateway/node_modules/zca-js/dist/apis/getContext.js:3` | No public context endpoint; pick whitelisted internal fields only. |
| keepAlive is HTTP API | `apps/zalo-account-gateway/node_modules/zca-js/dist/apis/keepAlive.js:4` | It is not proof socket open; no automatic polling by default. |
| Status checks only live lease | `packages/business/src/zalo-account/service.ts:50` | Preserve gatewayAvailable semantics; new socket snapshot has freshness/unknown. |
| Secret loader only checks account existence | `packages/business/src/zalo-account/service.ts:160` | Recheck eligibility on every initial/recovery start before calling provider. |
| Runtime DB write is already fenced and row-locked | `packages/database/src/repositories/integration-zalo-account/repository.ts:32` | Extend Zalo-specific path, preserve JSON siblings and transaction boundaries. |
| Existing keyset recovery query | `packages/database/src/repositories/integration-zalo-account/repository.ts:248` | Reuse bounded ID pages instead of full table/all-workspace sweep. |
| Startup recovery precedes consumer/server start | `apps/zalo-account-gateway/src/main.ts:114` | Slow account must not hold transport startup hostage. |
| Session lifecycle handles only qr_scanned | `apps/worker/src/events/zalo-account/handler.ts:52` | Map Zalo-specific terminal QR events to existing fail/status APIs. |
| Account lifecycle updates current shared transitions | `apps/worker/src/events/zalo-account/handler.ts:90` | Do not change generic Connection enums/state machine. |
| Authorization accepted once in device ceremony | `packages/connections/src/device-session-flow.ts:314` | Do not reuse completeTrustedDeviceAuthorization for background cookie refresh. |
| Status action requires superAdmin | `apps/builder/src/features/zalo-accounts/actions/account-operations.action.ts:20` | Do not broadcast diagnostic values to all members. |
| Status action also reads groups | `apps/builder/src/features/zalo-accounts/actions/account-operations.action.ts:26` | Add status-only action/read path or preserve contract with demand-loaded groups; list consumers. |
| Per-account status polling fixed at 30s | `apps/builder/src/features/zalo-accounts/queries/use-account-operations.ts:27` | Scope polling to visible settings; realtime invalidation coalesced. |
| Shared realtime has registry/delivery/guest allowlist | `packages/realtime-protocol/src/schemas.ts:3` | Any additive event must register all mappings and remain guest-excluded. |
| Feature subscriptions already clean up | `apps/builder/src/features/realtime/use-workspace-realtime-events.ts:14` | Reuse existing provider; no new socket per row/account. |
| UI validates realtime data through registry | `apps/builder/src/features/realtime/realtime-event-validation.ts:27` | Add only Zalo-specific schema; old event semantics unchanged. |
| Generic failSession accepts guarded statuses | `packages/connections/src/connect-targets.ts:37` | QR failure must not overwrite completed/cancelled session. |

## Verified test/command owners

- Gateway package `zalo-account-gateway`: `__tests__/zalo-account-runtime.test.ts`, `zalo-account-pool.test.ts`, `account-lease-store.test.ts`, `reconcile-active-accounts.test.ts`, `fenced-event-publisher.test.ts`, `server.test.ts`.
- SDK package `@chatbotx.io/sdk`: `__tests__/zalo-account-runtime-order.test.ts`, `zalo-account.test.ts`, `zalo-account-transport.test.ts`.
- Business package `@chatbotx.io/business`: `__tests__/zalo-account-runtime-state.test.ts`, `zalo-account.service.test.ts`.
- Worker package `worker`: `__tests__/zalo-account-events.test.ts`.
- Connections package `@chatbotx.io/connections`: `__tests__/device-session-flow.test.ts`, `zalo-account-runtime.test.ts`, `zalo-account-teardown.test.ts`, `messenger-teardown.test.ts`, `lifecycle.test.ts`.
- Builder package `builder`: `__tests__/zalo-account-connect-ui.test.tsx`, `zalo-account-manage-ui.test.tsx`, `zalo-accounts-action-permissions.test.ts`, `zalo-accounts-public-api.test.ts`, `edge-instrumentation-graph.test.ts`, `workspace-realtime-provider.test.tsx`, `connection-status-message.test.ts`.
- Realtime protocol package `@chatbotx.io/realtime-protocol`: `__tests__/schemas.test.ts`, `stream.test.ts`.
- Use `VITEST_MAX_WORKERS=1 pnpm --filter <workspace> exec vitest run <file>` for focused future runs; `pnpm --filter ... test -- <file>` is not a reliable scoped run here.
- Full gate at implementation completion: lint → touched-workspace types sequentially → affected suites → required coverage without threshold bypass; see `.agents/skills/testing-workflow/SKILL.md`.

No tests, provider calls, builds or migrations were run to create this inventory.
